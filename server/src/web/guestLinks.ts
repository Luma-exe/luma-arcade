import { randomBytes } from "node:crypto";
import { getDb } from "../db/index.js";
import { getSetting } from "../config/settings.js";
import { MOONLIGHT_PATH_PREFIX } from "../remote/moonlightWebStream.js";
import { readData } from "../remote/moonlightData.js";
import { totalUsage } from "./playLog.js";
import { profilesInstalled, runProfiles } from "./profilesScript.js";
import { copyStreamSetup } from "./streamSetup.js";

// Temporary links for people without an account: "play for an hour", or
// "join my game as player 2". Every link gets its own throwaway
// moonlight-web-stream user (created with the admin's own session, since
// only admins may add users there); opening the link signs the visitor in
// as that user (routes/guestLinks.ts). The link's play time and expiry are
// enforced like any time limit (limits.ts calls guestAllowance), so the
// stream page warns before the end and the proxy ends the stream on time.

export type GuestMode = "play" | "coop";

export interface GuestLinkRow {
  id: number;
  token: string;
  name: string;
  mode: GuestMode;
  user_id: number;
  user_name: string;
  password: string;
  minutes: number | null;
  expires_at: number;
  created_by_id: number;
  created_by: string;
  created_at: number;
  revoked_at: number | null;
  account_deleted_at: number | null;
  uses: number;
  first_used_at: number | null;
  last_used_at: number | null;
  converted_to_user_id: number | null;
  converted_to_name: string | null;
  converted_at: number | null;
  /** the game it opens straight into (game_plays.id), else null */
  game_play_id: number | null;
}

/** Links whose account can go once they've been expired this long. */
const CLEANUP_AFTER_MS = 24 * 3_600_000;

// --- moonlight-web-stream's API, as the admin who is asking

async function moonlight(cookie: string, method: string, path: string, body?: unknown): Promise<Response> {
  const port = getSetting("moonlightWebStreamPort");
  return fetch(`http://127.0.0.1:${port}${MOONLIGHT_PATH_PREFIX}/api${path}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
}

/** The role guest accounts get: one called "Guest", else any non-admin. */
function guestRoleId(): number {
  const roles = Object.entries(readData().roles ?? {}) as [string, { name: string; ty?: string }][];
  const players = roles.filter(([, r]) => r.ty !== "Admin");
  const guest = players.find(([, r]) => /guest/i.test(r.name)) ?? players[0];
  if (!guest) throw new Error("moonlight-web-stream has no player role to give guests - add one in the admin screen");
  return Number(guest[0]);
}

function token(bytes = 18): string {
  return randomBytes(bytes).toString("base64url");
}

async function createAccount(cookie: string, name: string): Promise<{ id: number; name: string; password: string }> {
  const password = token(24);
  const roleId = guestRoleId();
  // Names are unique there; a short tag keeps two "Sam"s apart.
  for (const suffix of ["", ` ${token(2)}`, ` ${token(3)}`]) {
    const userName = `${name} (guest${suffix})`.slice(0, 60);
    const res = await moonlight(cookie, "POST", "/user", { name: userName, password, role_id: roleId, client_unique_id: `luma-guest-${token(6)}` });
    if (res.ok) {
      const user = (await res.json()) as { id: number; name: string };
      return { id: user.id, name: user.name ?? userName, password };
    }
    if (res.status === 401 || res.status === 403) throw new Error("Only admins can make guest links");
    if (res.status !== 409 && res.status !== 400) throw new Error(`moonlight-web-stream said ${res.status} ${await res.text().catch(() => "")}`.trim());
  }
  throw new Error("Couldn't find a free name for the guest account");
}

async function deleteAccount(cookie: string, userId: number): Promise<void> {
  const res = await moonlight(cookie, "DELETE", "/user", { id: userId });
  // Already gone counts as done.
  if (!res.ok && res.status !== 404) throw new Error(`moonlight-web-stream said ${res.status}`);
}

/** Sign in as the link's account; returns moonlight-web-stream's cookies. */
export async function signIn(link: GuestLinkRow): Promise<string[]> {
  const port = getSetting("moonlightWebStreamPort");
  const res = await fetch(`http://127.0.0.1:${port}${MOONLIGHT_PATH_PREFIX}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: link.user_name, password: link.password }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`sign-in failed (${res.status})`);
  return res.headers.getSetCookie();
}

// --- links

export interface NewLink {
  name: string;
  mode: GuestMode;
  /** total play time, null = no cap before it expires */
  minutes: number | null;
  /** how long the link works */
  hours: number;
  /** a game to open straight into (game_plays.id), own-turn links only */
  gameId?: number | null;
}

export async function createLink(cookie: string, by: { id: number; name: string }, link: NewLink, now = Date.now()): Promise<GuestLinkRow> {
  const account = await createAccount(cookie, link.name);
  const row = {
    token: token(),
    name: link.name,
    mode: link.mode,
    user_id: account.id,
    user_name: account.name,
    password: account.password,
    minutes: link.minutes,
    expires_at: now + link.hours * 3_600_000,
    created_by_id: by.id,
    created_by: by.name,
    created_at: now,
    game_play_id: link.mode === "play" ? (link.gameId ?? null) : null,
  };
  const id = Number(
    getDb()
      .prepare(
        `INSERT INTO guest_links (token, name, mode, user_id, user_name, password, minutes, expires_at, created_by_id, created_by, created_at, game_play_id)
         VALUES (@token, @name, @mode, @user_id, @user_name, @password, @minutes, @expires_at, @created_by_id, @created_by, @created_at, @game_play_id)`
      )
      .run(row).lastInsertRowid
  );
  return getLink(id)!;
}

export function getLink(id: number): GuestLinkRow | null {
  return (getDb().prepare("SELECT * FROM guest_links WHERE id = ?").get(id) as GuestLinkRow | undefined) ?? null;
}

export function linkByToken(t: string): GuestLinkRow | null {
  return (getDb().prepare("SELECT * FROM guest_links WHERE token = ?").get(t) as GuestLinkRow | undefined) ?? null;
}

export function allLinks(): GuestLinkRow[] {
  return getDb().prepare("SELECT * FROM guest_links ORDER BY created_at DESC").all() as GuestLinkRow[];
}

/** The live link behind a moonlight-web-stream user, if it's a guest. */
export function linkForUser(userId: number): GuestLinkRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM guest_links WHERE user_id = ? AND account_deleted_at IS NULL ORDER BY created_at DESC LIMIT 1")
      .get(userId) as GuestLinkRow | undefined) ?? null
  );
}

/** Every account that belongs to a guest link (kept off people lists). */
export function guestUserIds(): Set<number> {
  return new Set((getDb().prepare("SELECT user_id FROM guest_links").all() as { user_id: number }[]).map((r) => r.user_id));
}

export function recordUse(link: GuestLinkRow, now = Date.now()): void {
  getDb()
    .prepare("UPDATE guest_links SET uses = uses + 1, first_used_at = COALESCE(first_used_at, ?), last_used_at = ? WHERE id = ?")
    .run(now, now, link.id);
}

/** Change play time and/or how long it keeps working. */
export function updateLink(id: number, change: { minutes?: number | null; hours?: number | null }, now = Date.now()): GuestLinkRow {
  const link = getLink(id);
  if (!link) throw new Error("No such link");
  if (link.account_deleted_at) throw new Error("This link's account is gone; make a new link instead");
  if (change.minutes !== undefined) {
    getDb().prepare("UPDATE guest_links SET minutes = ? WHERE id = ?").run(change.minutes, id);
  }
  if (change.hours != null) {
    getDb().prepare("UPDATE guest_links SET expires_at = ? WHERE id = ?").run(now + change.hours * 3_600_000, id);
  }
  return getLink(id)!;
}

/** Turn it off for good: its account goes, which also signs them out. */
export async function revokeLink(cookie: string, id: number, now = Date.now()): Promise<void> {
  const link = getLink(id);
  if (!link) throw new Error("No such link");
  getDb().prepare("UPDATE guest_links SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(now, id);
  if (!link.account_deleted_at) {
    await deleteAccount(cookie, link.user_id);
    getDb().prepare("UPDATE guest_links SET account_deleted_at = ? WHERE id = ?").run(now, id);
  }
}

/** Remove it from the list (revoking it first). */
export async function removeLink(cookie: string, id: number): Promise<void> {
  await revokeLink(cookie, id);
  getDb().prepare("DELETE FROM guest_links WHERE id = ?").run(id);
}

/** Delete the accounts of links that ended a while ago (run whenever an
 * admin looks at the list, since that needs their session). */
export async function cleanUpAccounts(cookie: string, now = Date.now()): Promise<number> {
  const stale = getDb()
    .prepare("SELECT * FROM guest_links WHERE account_deleted_at IS NULL AND (revoked_at IS NOT NULL OR expires_at < ?)")
    .all(now - CLEANUP_AFTER_MS) as GuestLinkRow[];
  let done = 0;
  for (const link of stale) {
    try {
      await deleteAccount(cookie, link.user_id);
      getDb().prepare("UPDATE guest_links SET account_deleted_at = ? WHERE id = ?").run(now, link.id);
      done++;
    } catch {
      // try again next time
    }
  }
  return done;
}

// --- time

export type LinkState = "unused" | "active" | "expired" | "revoked" | "used-up" | "converted";

/** How much of the link is left: null when the user isn't a guest link. */
export function guestAllowance(userId: number, now = Date.now()): { remainingMs: number; reason?: string; usedMs: number } | null {
  const link = linkForUser(userId);
  if (!link) return null;
  const usedMs = totalUsage(userId, now);
  if (link.revoked_at) return { remainingMs: 0, usedMs, reason: "This guest link was turned off." };
  const untilExpiry = link.expires_at - now;
  if (untilExpiry <= 0) return { remainingMs: 0, usedMs, reason: "This guest link has expired. Ask for a new one!" };
  if (link.minutes == null) return { remainingMs: untilExpiry, usedMs };
  const left = Math.max(0, link.minutes * 60_000 - usedMs);
  if (left === 0) return { remainingMs: 0, usedMs, reason: "That's all the play time on this guest link. Thanks for playing!" };
  return { remainingMs: Math.min(left, untilExpiry), usedMs };
}

export function linkState(link: GuestLinkRow, now = Date.now()): LinkState {
  if (link.converted_at) return "converted";
  if (link.revoked_at) return "revoked";
  if (link.expires_at <= now) return "expired";
  if (link.minutes != null && totalUsage(link.user_id, now) >= link.minutes * 60_000) return "used-up";
  return link.uses ? "active" : "unused";
}

// --- turning a guest into a real account

export interface NewAccount {
  name: string;
  password: string;
  roleId: number;
}

function checkAccount(a: NewAccount): void {
  if (!a.name || a.name.length > 40) throw new Error("Give the account a name (up to 40 characters)");
  if (!a.password || a.password.length < 4) throw new Error("The password needs at least 4 characters");
  const roles = readData().roles ?? {};
  if (!(String(a.roleId) in roles)) throw new Error("Pick a role for the account");
}

/** Make a real account and give it everything the guest built up: saves
 * (wherever they are right now), ES-DE favorites and play counts,
 * snapshots and play history. Then the guest link is turned off.
 *
 * Safe to run again: if the account was made but moving the saves failed,
 * a second try reuses that account. */
export async function convertLink(cookie: string, id: number, account: NewAccount, now = Date.now()): Promise<GuestLinkRow> {
  let link = getLink(id);
  if (!link) throw new Error("No such link");
  if (link.converted_at) throw new Error(`This guest already became ${link.converted_to_name}'s account`);

  let userId = link.converted_to_user_id;
  let userName = link.converted_to_name ?? account.name;
  if (userId == null) {
    checkAccount(account);
    const res = await moonlight(cookie, "POST", "/user", {
      name: account.name,
      password: account.password,
      role_id: account.roleId,
      client_unique_id: account.name,
    });
    if (res.status === 409 || res.status === 400) throw new Error(`There's already an account called ${account.name}`);
    if (res.status === 401 || res.status === 403) throw new Error("Only admins can make accounts");
    if (!res.ok) throw new Error(`moonlight-web-stream said ${res.status}`);
    const user = (await res.json()) as { id: number; name?: string };
    userId = user.id;
    userName = user.name ?? account.name;
    getDb().prepare("UPDATE guest_links SET converted_to_user_id = ?, converted_to_name = ? WHERE id = ?").run(userId, userName, id);
  }

  // Saves, stats and snapshots (the per-player saves script, if it's set up).
  if (profilesInstalled()) {
    const result = await runProfiles(["-Action", "transfer", "-From", String(link.user_id), "-To", `${userId}:${userName}`]);
    if (result.error) throw new Error(`The account ${userName} was made, but the saves didn't move: ${result.error}. Try again.`);
  }

  // Play history
  getDb().prepare("UPDATE play_sessions SET user_id = ?, user_name = ? WHERE user_id = ?").run(userId, userName, link.user_id);
  // Their stream setup, so the new account isn't asked again
  copyStreamSetup(link.user_id, userId);

  getDb().prepare("UPDATE guest_links SET converted_at = ? WHERE id = ?").run(now, id);
  await revokeLink(cookie, id, now);
  link = getLink(id)!;
  return link;
}

// --- defaults for new links (admin screen), kept in the settings table

const DEFAULTS_KEY = "guestLinkDefaults";

export interface GuestDefaults {
  mode: GuestMode;
  /** total play time, null = no cap */
  minutes: number | null;
  /** how long a link works */
  hours: number;
  /** apps an own-turn guest may start; null = every app */
  apps: string[] | null;
  /** settings screen sections they may open; null = every player section */
  settings: string[] | null;
}

const BUILT_IN: GuestDefaults = { mode: "play", minutes: 60, hours: 24, apps: null, settings: null };

function stringList(v: unknown): string[] | null {
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string"))] : null;
}

/** Checks and tidies defaults (or a link's own choices); throws on nonsense. */
export function cleanDefaults(input: unknown, base: GuestDefaults = BUILT_IN): GuestDefaults {
  const b = (input ?? {}) as Record<string, unknown>;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  const mode: GuestMode = has("mode") ? (b.mode === "coop" ? "coop" : "play") : base.mode;
  const minutes = has("minutes") ? (b.minutes == null || b.minutes === "" ? null : Math.round(Number(b.minutes))) : base.minutes;
  if (minutes !== null && !(minutes > 0 && minutes <= 7 * 24 * 60)) throw new Error("Play time must be between 1 minute and a week");
  const hours = has("hours") ? Number(b.hours) : base.hours;
  if (!(hours > 0 && hours <= 24 * 90)) throw new Error("A link can last between a few minutes and 90 days");
  const apps = has("apps") ? stringList(b.apps) : base.apps;
  const settings = has("settings") ? stringList(b.settings) : base.settings;
  return { mode, minutes, hours, apps, settings };
}

export function getGuestDefaults(): GuestDefaults {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(DEFAULTS_KEY) as { value: string } | undefined;
  if (!row) return { ...BUILT_IN };
  try {
    return cleanDefaults(JSON.parse(row.value));
  } catch {
    return { ...BUILT_IN };
  }
}

export function setGuestDefaults(input: unknown): GuestDefaults {
  const clean = cleanDefaults(input, getGuestDefaults());
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(DEFAULTS_KEY, JSON.stringify(clean));
  return clean;
}
