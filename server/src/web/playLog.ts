import { getDb } from "../db/index.js";

// Who played what, and for how long (the admin screen's Play history). A
// row per stretch of streaming: opened when a stream's Init gets through
// (appAccess.ts), closed when its WebSocket does. Reconnecting to the same
// app shortly after continues the same row, so a dropped connection doesn't
// split one evening into many.

/** A reconnect within this long continues the previous row. */
const RESUME_MS = 2 * 60_000;
/** Open rows get their last_seen_at bumped this often. */
const TOUCH_MS = 60_000;

let touchTimer: NodeJS.Timeout | null = null;

/** Close rows left open by a stop or crash (at the last time they were
 * seen), then keep open rows' last_seen_at current. */
export function initPlayLog(): void {
  getDb().prepare("UPDATE play_sessions SET ended_at = last_seen_at WHERE ended_at IS NULL").run();
  touchTimer ??= setInterval(() => {
    getDb().prepare("UPDATE play_sessions SET last_seen_at = ? WHERE ended_at IS NULL").run(Date.now());
  }, TOUCH_MS).unref();
}

export function playStarted(userId: number, userName: string, app: string, now = Date.now(), guest = false): number {
  const db = getDb();
  const recent = db
    .prepare(
      `SELECT id FROM play_sessions WHERE user_id = ? AND app = ? AND ended_at IS NOT NULL AND ended_at >= ?
       ORDER BY ended_at DESC LIMIT 1`
    )
    .get(userId, app, now - RESUME_MS) as { id: number } | undefined;
  if (recent) {
    db.prepare("UPDATE play_sessions SET ended_at = NULL, last_seen_at = ? WHERE id = ?").run(now, recent.id);
    return recent.id;
  }
  return Number(
    db
      .prepare("INSERT INTO play_sessions (user_id, user_name, app, started_at, last_seen_at, guest) VALUES (?, ?, ?, ?, ?, ?)")
      .run(userId, userName, app, now, now, guest ? 1 : 0).lastInsertRowid
  );
}

export function playEnded(id: number, now = Date.now()): void {
  getDb().prepare("UPDATE play_sessions SET ended_at = ?, last_seen_at = ? WHERE id = ? AND ended_at IS NULL").run(now, now, id);
}

/** One 30-second sample from the stream page (activity.js). Counts are
 * over that sample, not totals. */
export interface QualitySample {
  kbps?: number;
  fps?: number;
  rttMs?: number;
  frames?: number;
  dropped?: number;
  packets?: number;
  lost?: number;
  width?: number;
  height?: number;
  relay?: boolean;
  /** The frame rate the stream was asked for, to judge fps against. */
  targetFps?: number;
}

const num = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : 0);

/** Was this sample one a player would notice: choppy, laggy or lossy? */
export function badSample(q: QualitySample): boolean {
  const fps = num(q.fps, 1000);
  const target = num(q.targetFps, 1000) || 60;
  const frames = num(q.frames, 1e7);
  const packets = num(q.packets, 1e8);
  return (
    (fps > 0 && fps < target * 0.8) ||
    num(q.rttMs, 1e5) > 80 ||
    (frames > 0 && num(q.dropped, 1e7) / frames > 0.02) ||
    (packets > 0 && num(q.lost, 1e8) / packets > 0.01)
  );
}

/** Add a sample to this person's open play rows. */
export function recordQuality(userId: number, q: QualitySample): void {
  const size = q.width && q.height ? `${Math.round(num(q.width, 1e5))}x${Math.round(num(q.height, 1e5))}` : null;
  getDb()
    .prepare(
      `UPDATE play_sessions SET
         q_samples = q_samples + 1, q_kbps_sum = q_kbps_sum + ?, q_fps_sum = q_fps_sum + ?,
         q_rtt_sum = q_rtt_sum + ?, q_rtt_max = MAX(q_rtt_max, ?),
         q_frames = q_frames + ?, q_dropped = q_dropped + ?, q_packets = q_packets + ?, q_lost = q_lost + ?,
         q_bad = q_bad + ?, q_size = COALESCE(?, q_size), q_relay = MAX(q_relay, ?)
       WHERE user_id = ? AND ended_at IS NULL`
    )
    .run(
      num(q.kbps, 1e7),
      num(q.fps, 1000),
      num(q.rttMs, 1e5),
      num(q.rttMs, 1e5),
      Math.round(num(q.frames, 1e7)),
      Math.round(num(q.dropped, 1e7)),
      Math.round(num(q.packets, 1e8)),
      Math.round(num(q.lost, 1e8)),
      badSample(q) ? 1 : 0,
      size,
      q.relay ? 1 : 0,
      userId
    );
}

/** Start of today and of this week (Monday), in the host's time zone. */
export function periodStarts(now = Date.now()): { day: number; week: number } {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const day = d.getTime();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return { day, week: d.getTime() };
}

/** How long this person has played today and this week (as themselves or
 * as a guest), counting streams still going. */
export function usage(userId: number, now = Date.now()): { todayMs: number; weekMs: number } {
  const { day, week } = periodStarts(now);
  const rows = getDb()
    .prepare("SELECT started_at, ended_at FROM play_sessions WHERE user_id = ? AND COALESCE(ended_at, ?) > ?")
    .all(userId, now, week) as { started_at: number; ended_at: number | null }[];
  let todayMs = 0;
  let weekMs = 0;
  for (const r of rows) {
    const end = r.ended_at ?? now;
    weekMs += Math.max(0, end - Math.max(r.started_at, week));
    todayMs += Math.max(0, end - Math.max(r.started_at, day));
  }
  return { todayMs, weekMs };
}

/** Everything this person has ever played (guest links count all of it). */
export function totalUsage(userId: number, now = Date.now()): number {
  const row = getDb()
    .prepare("SELECT COALESCE(SUM(COALESCE(ended_at, ?) - started_at), 0) AS ms FROM play_sessions WHERE user_id = ?")
    .get(now, userId) as { ms: number };
  return Math.max(0, row.ms);
}

export interface Quality {
  /** "great" | "good" | "fair" | "poor" over the whole session */
  grade: string;
  kbps: number;
  fps: number;
  rttMs: number;
  worstRttMs: number;
  droppedPct: number;
  lossPct: number;
  /** Minutes that were choppy, laggy or lossy. */
  badMinutes: number;
  size: string | null;
  relay: boolean;
}

export interface PlaySession {
  id: number;
  userId: number;
  user: string;
  app: string;
  startedAt: number;
  /** null while it's still going */
  endedAt: number | null;
  durationMs: number;
  guest: boolean;
  /** null when the stream page never reported (e.g. an older page) */
  quality: Quality | null;
}

export interface PlaySummary {
  since: number;
  sessions: PlaySession[];
  byUser: { userId: number; user: string; ms: number; sessions: number }[];
  byApp: { app: string; ms: number; sessions: number }[];
}

/** Everything that started in the last `days` days (newest first, at most
 * `limit` rows listed; the totals count them all). */
export function playSummary(days: number, limit = 200, now = Date.now()): PlaySummary {
  const since = now - days * 86_400_000;
  const rows = getDb()
    .prepare(
      `SELECT * FROM play_sessions WHERE started_at >= ? ORDER BY started_at DESC`
    )
    .all(since) as Row[];

  const sessions: PlaySession[] = rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    user: r.user_name,
    app: r.app,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: Math.max(0, (r.ended_at ?? now) - r.started_at),
    guest: !!r.guest,
    quality: quality(r),
  }));

  const users = new Map<number, PlaySummary["byUser"][number]>();
  const apps = new Map<string, PlaySummary["byApp"][number]>();
  for (const s of sessions) {
    const u = users.get(s.userId) ?? { userId: s.userId, user: s.user, ms: 0, sessions: 0 };
    u.ms += s.durationMs;
    u.sessions += 1;
    users.set(s.userId, u);
    const a = apps.get(s.app) ?? { app: s.app, ms: 0, sessions: 0 };
    a.ms += s.durationMs;
    a.sessions += 1;
    apps.set(s.app, a);
  }
  return {
    since,
    sessions: sessions.slice(0, limit),
    byUser: [...users.values()].sort((a, b) => b.ms - a.ms),
    byApp: [...apps.values()].sort((a, b) => b.ms - a.ms),
  };
}

interface Row {
  id: number;
  user_id: number;
  user_name: string;
  app: string;
  started_at: number;
  ended_at: number | null;
  last_seen_at: number;
  guest: number;
  q_samples: number;
  q_kbps_sum: number;
  q_fps_sum: number;
  q_rtt_sum: number;
  q_rtt_max: number;
  q_frames: number;
  q_dropped: number;
  q_packets: number;
  q_lost: number;
  q_bad: number;
  q_size: string | null;
  q_relay: number;
}

const SAMPLE_MINUTES = 0.5;

function quality(r: Row): Quality | null {
  if (!r.q_samples) return null;
  const n = r.q_samples;
  const badShare = r.q_bad / n;
  const grade = badShare < 0.05 ? "great" : badShare < 0.15 ? "good" : badShare < 0.35 ? "fair" : "poor";
  const round = (v: number, d = 0) => Math.round(v * 10 ** d) / 10 ** d;
  return {
    grade,
    kbps: Math.round(r.q_kbps_sum / n),
    fps: round(r.q_fps_sum / n, 1),
    rttMs: Math.round(r.q_rtt_sum / n),
    worstRttMs: Math.round(r.q_rtt_max),
    droppedPct: r.q_frames ? round((r.q_dropped / r.q_frames) * 100, 2) : 0,
    lossPct: r.q_packets ? round((r.q_lost / r.q_packets) * 100, 2) : 0,
    badMinutes: round(r.q_bad * SAMPLE_MINUTES, 1),
    size: r.q_size,
    relay: !!r.q_relay,
  };
}
