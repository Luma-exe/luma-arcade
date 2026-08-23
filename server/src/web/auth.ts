import bcrypt from "bcrypt";
import { randomBytes } from "node:crypto";
import { getDb } from "../db/index.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SALT_ROUNDS = 12;

export function isPasswordSet(): boolean {
  const row = getDb().prepare("SELECT id FROM auth WHERE id = 1").get();
  return !!row;
}

/** Sets the password only if none exists yet. A plain INSERT (no upsert)
 * so two concurrent first-run requests can't race each other into both
 * "succeeding" — whichever loses hits the UNIQUE constraint on `id` and
 * gets told the password is already set, instead of silently overwriting
 * whatever the winner just set. There's no "change password" flow today
 * (this is the only caller of this function), so there's no legitimate
 * case where an existing password should be overwritten here. */
export async function setPassword(password: string): Promise<boolean> {
  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  try {
    getDb().prepare(`INSERT INTO auth (id, password_hash) VALUES (1, ?)`).run(hash);
    return true;
  } catch (err) {
    const code = err instanceof Error && "code" in err ? (err as { code?: string }).code : undefined;
    if (code?.startsWith("SQLITE_CONSTRAINT")) {
      return false;
    }
    throw err;
  }
}

export async function verifyPassword(password: string): Promise<boolean> {
  const row = getDb().prepare("SELECT password_hash FROM auth WHERE id = 1").get() as
    | { password_hash: string }
    | undefined;
  if (!row) return false;
  return bcrypt.compare(password, row.password_hash);
}

export function createSession(): { id: string; expiresAt: Date } {
  const id = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  getDb()
    .prepare("INSERT INTO sessions (id, expires_at) VALUES (?, ?)")
    .run(id, expiresAt.toISOString());
  return { id, expiresAt };
}

export function isSessionValid(sessionId: string): boolean {
  const row = getDb()
    .prepare("SELECT expires_at FROM sessions WHERE id = ?")
    .get(sessionId) as { expires_at: string } | undefined;
  if (!row) return false;
  return new Date(row.expires_at).getTime() > Date.now();
}

export function destroySession(sessionId: string): void {
  getDb().prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

/** Deletes expired session rows. Sessions otherwise only ever leave the
 * table via an explicit logout, so a server that just sits there for 30
 * days (SESSION_TTL_MS) accumulates one dead row per login forever. */
export function pruneExpiredSessions(): number {
  const result = getDb().prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
  return result.changes;
}

// Simple in-memory sliding-window rate limiter for the login route. Entries
// are never removed except by clearAttempts (a successful login) or
// pruneStaleAttempts below — without that second path, an attacker (or
// anyone mistyping their password) from a constant stream of distinct IPs
// grows this Map forever.
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;

export function isRateLimited(ip: string): boolean {
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < Date.now()) return false;
  return entry.count >= MAX_ATTEMPTS;
}

export function recordFailedAttempt(ip: string): void {
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < Date.now()) {
    attempts.set(ip, { count: 1, resetAt: Date.now() + WINDOW_MS });
    return;
  }
  entry.count += 1;
}

export function clearAttempts(ip: string): void {
  attempts.delete(ip);
}

/** Drops rate-limiter entries whose window has already expired. */
export function pruneStaleAttempts(): number {
  const now = Date.now();
  let removed = 0;
  for (const [ip, entry] of attempts) {
    if (entry.resetAt < now) {
      attempts.delete(ip);
      removed++;
    }
  }
  return removed;
}
