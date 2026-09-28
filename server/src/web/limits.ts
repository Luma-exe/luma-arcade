import { getDb } from "../db/index.js";
import { guestAllowance } from "./guestLinks.js";
import { usage } from "./playLog.js";
import type { StreamUser } from "./streamUser.js";

// Play time limits per person (admin screen): minutes per day and/or per
// week, counted from the play log (time as a co-op guest counts too).
// Admins never have limits. A stream that runs into its limit is ended
// (appAccess.ts); the stream page warns before that.

export interface TimeLimits {
  dailyMinutes: number | null;
  weeklyMinutes: number | null;
}

function minutesOrNull(v: unknown): number | null {
  const n = Number(v);
  return v == null || v === "" || !Number.isFinite(n) || n <= 0 ? null : Math.min(Math.round(n), 7 * 24 * 60);
}

export function getLimits(userId: number): TimeLimits {
  const row = getDb().prepare("SELECT daily_minutes, weekly_minutes FROM user_access WHERE user_id = ?").get(userId) as
    | { daily_minutes: number | null; weekly_minutes: number | null }
    | undefined;
  return { dailyMinutes: row?.daily_minutes ?? null, weeklyMinutes: row?.weekly_minutes ?? null };
}

export function getAllLimits(): Record<number, TimeLimits> {
  const rows = getDb().prepare("SELECT user_id, daily_minutes, weekly_minutes FROM user_access").all() as {
    user_id: number;
    daily_minutes: number | null;
    weekly_minutes: number | null;
  }[];
  const out: Record<number, TimeLimits> = {};
  for (const r of rows) out[r.user_id] = { dailyMinutes: r.daily_minutes, weeklyMinutes: r.weekly_minutes };
  return out;
}

export function setLimits(userId: number, body: unknown): TimeLimits {
  const b = (body ?? {}) as { dailyMinutes?: unknown; weeklyMinutes?: unknown };
  const limits = { dailyMinutes: minutesOrNull(b.dailyMinutes), weeklyMinutes: minutesOrNull(b.weeklyMinutes) };
  getDb()
    .prepare(
      `INSERT INTO user_access (user_id, daily_minutes, weekly_minutes) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET daily_minutes = excluded.daily_minutes,
         weekly_minutes = excluded.weekly_minutes, updated_at = datetime('now')`
    )
    .run(userId, limits.dailyMinutes, limits.weeklyMinutes);
  return limits;
}

export interface TimeLeft {
  /** null = no limit */
  remainingMs: number | null;
  todayMs: number;
  weekMs: number;
  limits: TimeLimits;
  /** Why they can't play now, once remainingMs is 0. */
  reason?: string;
  /** Signed in through a guest link. */
  guest?: boolean;
}

function hours(ms: number): string {
  const min = Math.round(ms / 60_000);
  const h = Math.floor(min / 60);
  if (!h) return `${min} min`;
  return `${h} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

export function timeLeft(user: StreamUser, now = Date.now()): TimeLeft {
  const limits = user.admin ? { dailyMinutes: null, weeklyMinutes: null } : getLimits(user.id);
  const used = usage(user.id, now);
  let remainingMs: number | null = null;
  let reason: string | undefined;
  if (limits.dailyMinutes != null) {
    remainingMs = Math.max(0, limits.dailyMinutes * 60_000 - used.todayMs);
    if (remainingMs === 0) reason = `You've played your ${hours(limits.dailyMinutes * 60_000)} for today. See you tomorrow!`;
  }
  if (limits.weeklyMinutes != null) {
    const week = Math.max(0, limits.weeklyMinutes * 60_000 - used.weekMs);
    if (remainingMs == null || week < remainingMs) {
      remainingMs = week;
      if (week === 0) reason = `You've played your ${hours(limits.weeklyMinutes * 60_000)} for this week. It starts again on Monday.`;
    }
  }
  // A guest link's own play time and expiry (guestLinks.ts).
  const guest = user.admin ? null : guestAllowance(user.id, now);
  if (guest && (remainingMs == null || guest.remainingMs < remainingMs)) {
    remainingMs = guest.remainingMs;
    reason = guest.reason ?? reason;
  }
  return { remainingMs, todayMs: used.todayMs, weekMs: used.weekMs, limits, reason, guest: !!guest };
}
