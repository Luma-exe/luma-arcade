import bcrypt from "bcrypt";
import { randomBytes } from "node:crypto";
import { getDb } from "../db/index.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SALT_ROUNDS = 12;

export function isPasswordSet(): boolean {
  const row = getDb().prepare("SELECT id FROM auth WHERE id = 1").get();
  return !!row;
}

export async function setPassword(password: string): Promise<void> {
  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  getDb()
    .prepare(
      `INSERT INTO auth (id, password_hash) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = datetime('now')`
    )
    .run(hash);
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

// Simple in-memory sliding-window rate limiter for the login route.
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
