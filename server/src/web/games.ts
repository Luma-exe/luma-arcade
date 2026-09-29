import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { getDb } from "../db/index.js";
import { notify } from "./notify.js";
import { profilesInstalled, runProfiles } from "./profilesScript.js";
import { currentPlayer, nobodyStreamingFor } from "./sessions.js";
import type { StreamUser } from "./streamUser.js";

// Which games are played inside ES-DE. Its game-start event script
// (moonlight host/esde-game-events.ps1, run by ES-DE and by "Continue
// playing") appends a line per step to games.jsonl; this reads them into
// game_plays, attributed to whoever had the PC. From that:
//  - the admin screen's play history, per game inside an app;
//  - "Continue playing" (what someone played last, and how to start it);
//  - a save snapshot of the player's saves when a game closes;
//  - closing a game nobody has streamed for IDLE_CLOSE_MS (it keeps the
//    GPU busy for nothing).

export const EVENTS_FILE = process.env.LUMA_GAMES_FILE || "C:\\ProgramData\\LumaArcade\\home\\games.jsonl";
const POLL_MS = 5000;
/** A game left running with nobody streaming is closed after this. */
export const IDLE_CLOSE_MS = 30 * 60_000;
/** A game closed this soon after starting isn't worth a snapshot. */
const SNAPSHOT_MIN_MS = 2 * 60_000;
/** Open rows can't run longer than this (an end the script never wrote). */
const MAX_PLAY_MS = 12 * 60 * 60_000;

export interface GameEvent {
  event: "start" | "running" | "end";
  id: string;
  at: number;
  name?: string;
  system?: string;
  rom?: string;
  pid?: number;
  exe?: string;
  commandLine?: string;
  reason?: string;
}

export interface GamePlay {
  id: number;
  launchId: string;
  userId: number;
  userName: string;
  app: string;
  title: string;
  system: string | null;
  rom: string | null;
  pid: number | null;
  exe: string | null;
  commandLine: string | null;
  startedAt: number;
  endedAt: number | null;
}

interface Row {
  id: number;
  launch_id: string;
  user_id: number;
  user_name: string;
  app: string;
  title: string;
  system: string | null;
  rom: string | null;
  pid: number | null;
  exe: string | null;
  command_line: string | null;
  started_at: number;
  ended_at: number | null;
}

const toPlay = (r: Row): GamePlay => ({
  id: r.id,
  launchId: r.launch_id,
  userId: r.user_id,
  userName: r.user_name,
  app: r.app,
  title: r.title,
  system: r.system,
  rom: r.rom,
  pid: r.pid,
  exe: r.exe,
  commandLine: r.command_line,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

// --- reading the events file

let offset = 0;
let partial = "";

/** New complete lines since the last read (from the start after a restart:
 * applying an event twice changes nothing). */
export function readNewEvents(file = EVENTS_FILE): GameEvent[] {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return [];
  }
  if (size < offset) {
    // Replaced or emptied: start over.
    offset = 0;
    partial = "";
  }
  if (size === offset) return [];
  const buf = Buffer.alloc(size - offset);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, buf.length, offset);
  } finally {
    closeSync(fd);
  }
  offset = size;
  const lines = (partial + buf.toString("utf8")).split("\n");
  partial = lines.pop() ?? "";
  const events: GameEvent[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line.replace(/^\uFEFF/, "")) as GameEvent;
      if (e && typeof e.id === "string" && typeof e.at === "number") events.push(e);
    } catch {
      // a torn line: skip it
    }
  }
  return events;
}

/** Tests. */
export function resetGames(): void {
  offset = 0;
  partial = "";
  idleClosed.clear();
}

// --- applying them

/** Who was streaming (as the player) at `at`, from the play log; else whoever has the PC now. */
function playerAt(at: number): { id: number; name: string; app: string } | null {
  const row = getDb()
    .prepare(
      `SELECT user_id, user_name, app FROM play_sessions
       WHERE guest = 0 AND started_at <= ? AND COALESCE(ended_at, last_seen_at) >= ? - 60000
       ORDER BY started_at DESC LIMIT 1`
    )
    .get(at, at) as { user_id: number; user_name: string; app: string } | undefined;
  if (row) return { id: row.user_id, name: row.user_name, app: row.app };
  const now = currentPlayer();
  return now ? { id: now.id, name: now.name, app: "ES-DE" } : null;
}

function rowFor(launchId: string): Row | undefined {
  return getDb().prepare("SELECT * FROM game_plays WHERE launch_id = ?").get(launchId) as Row | undefined;
}

/** `live`: the event just happened (not a replay at startup), so it may
 * trigger a snapshot. Returns the play it ended, if it ended one. */
export function applyEvent(e: GameEvent, live: boolean): GamePlay | null {
  const db = getDb();
  if (e.event === "start") {
    if (rowFor(e.id)) return null;
    // Whatever was still marked as running has ended by now.
    db.prepare("UPDATE game_plays SET ended_at = ? WHERE ended_at IS NULL AND started_at < ?").run(e.at, e.at);
    const who = playerAt(e.at);
    db.prepare(
      `INSERT OR IGNORE INTO game_plays (launch_id, user_id, user_name, app, title, system, rom, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      e.id,
      who?.id ?? 0,
      who?.name ?? "",
      who?.app ?? "ES-DE",
      cleanTitle(e.name, e.rom),
      e.system || null,
      e.rom || null,
      e.at
    );
    return null;
  }
  if (e.event === "running") {
    db.prepare("UPDATE game_plays SET pid = ?, exe = ?, command_line = ? WHERE launch_id = ?").run(
      Number.isSafeInteger(e.pid) ? e.pid : null,
      e.exe || null,
      e.commandLine || null,
      e.id
    );
    return null;
  }
  if (e.event === "end") {
    const changed = db.prepare("UPDATE game_plays SET ended_at = ? WHERE launch_id = ? AND ended_at IS NULL").run(e.at, e.id).changes;
    if (!changed) return null;
    const row = rowFor(e.id);
    const play = row ? toPlay(row) : null;
    if (play && live) void afterGame(play);
    return play;
  }
  return null;
}

function cleanTitle(name: string | undefined, rom: string | undefined): string {
  const n = (name ?? "").trim();
  if (n) return n.slice(0, 200);
  const file = (rom ?? "").split(/[\\/]/).pop() ?? "";
  return file.replace(/\.[a-z0-9]{1,5}$/i, "").slice(0, 200) || "Unknown game";
}

/** A game closed: put the player's saves aside as they are now. */
async function afterGame(play: GamePlay): Promise<void> {
  if (!play.userId || !profilesInstalled() || (play.endedAt ?? 0) - play.startedAt < SNAPSHOT_MIN_MS) return;
  try {
    await runProfiles(["-Action", "snapshot", "-Player", `${play.userId}:${play.userName}`, "-Label", `After ${play.title}`, "-Auto"]);
  } catch {
    // the saves script is a nice-to-have here
  }
}

// --- games nobody is streaming

const idleClosed = new Set<string>();

export function currentGame(): GamePlay | null {
  const row = getDb().prepare("SELECT * FROM game_plays WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1").get() as Row | undefined;
  return row ? toPlay(row) : null;
}

/** The running game to close for nobody, if it's time. */
export function gameToClose(now = Date.now()): GamePlay | null {
  const game = currentGame();
  if (!game || !game.pid || idleClosed.has(game.launchId)) return null;
  if (nobodyStreamingFor(now) < IDLE_CLOSE_MS) return null;
  return game;
}

type CloseGame = (pid: number) => Promise<{ ok: boolean; closed?: boolean; error?: string }>;

async function closeIdleGame(close: CloseGame, now = Date.now()): Promise<void> {
  const game = gameToClose(now);
  if (!game) return;
  idleClosed.add(game.launchId);
  const minutes = Math.round(nobodyStreamingFor(now) / 60_000);
  const result = await close(game.pid!).catch((err: Error) => ({ ok: false, error: err.message }));
  if (result.ok) {
    void notify(`💤 Closed ${game.title}${game.userName ? ` (${game.userName})` : ""}: nobody had streamed for ${minutes} min`);
  }
}

// --- what's been played

/** Per app, the games played in it since `since` (most played first). */
export function gamesByApp(
  since: number,
  now = Date.now()
): Map<string, { title: string; system: string | null; ms: number; plays: number; coverId: number }[]> {
  const rows = getDb()
    .prepare("SELECT id, app, title, system, started_at, ended_at FROM game_plays WHERE started_at >= ? ORDER BY id")
    .all(since) as Pick<Row, "id" | "app" | "title" | "system" | "started_at" | "ended_at">[];
  const byApp = new Map<string, Map<string, { title: string; system: string | null; ms: number; plays: number; coverId: number }>>();
  for (const r of rows) {
    const games = byApp.get(r.app) ?? new Map();
    byApp.set(r.app, games);
    const g = games.get(r.title) ?? { title: r.title, system: r.system, ms: 0, plays: 0, coverId: r.id };
    g.ms += Math.max(0, Math.min((r.ended_at ?? now) - r.started_at, MAX_PLAY_MS));
    g.plays += 1;
    // (the newest play's cover)
    g.coverId = r.id;
    games.set(r.title, g);
  }
  return new Map([...byApp].map(([app, games]) => [app, [...games.values()].sort((a, b) => b.ms - a.ms)]));
}

/** What this person played last that can be started again. */
export function lastGameFor(user: StreamUser): GamePlay | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM game_plays WHERE user_id = ? AND (rom IS NOT NULL OR exe IS NOT NULL)
       ORDER BY started_at DESC LIMIT 1`
    )
    .get(user.id) as Row | undefined;
  return row ? toPlay(row) : null;
}

// --- running it

let timer: NodeJS.Timeout | null = null;

/** Reads events every few seconds; closes idle games. */
export function startGameTracking(close: CloseGame): void {
  if (timer) return;
  const startedAt = Date.now();
  const tick = () => {
    try {
      for (const e of readNewEvents()) applyEvent(e, e.at > startedAt - 60_000);
    } catch {
      // database busy or file locked: next time
    }
    void closeIdleGame(close).catch(() => {});
  };
  tick();
  timer = setInterval(tick, POLL_MS);
  timer.unref();
}

/** Per person, the games they played since `since` (most played first). */
export function gamesByUser(since: number, now = Date.now()): Map<number, { title: string; ms: number; plays: number; coverId: number }[]> {
  const rows = getDb()
    .prepare("SELECT id, user_id, title, started_at, ended_at FROM game_plays WHERE started_at >= ? AND user_id != 0 ORDER BY id")
    .all(since) as Pick<Row, "id" | "user_id" | "title" | "started_at" | "ended_at">[];
  const byUser = new Map<number, Map<string, { title: string; ms: number; plays: number; coverId: number }>>();
  for (const r of rows) {
    const games = byUser.get(r.user_id) ?? new Map();
    byUser.set(r.user_id, games);
    const g = games.get(r.title) ?? { title: r.title, ms: 0, plays: 0, coverId: r.id };
    g.ms += Math.max(0, Math.min((r.ended_at ?? now) - r.started_at, MAX_PLAY_MS));
    g.plays += 1;
    g.coverId = r.id;
    games.set(r.title, g);
  }
  return new Map([...byUser].map(([id, games]) => [id, [...games.values()].sort((a, b) => b.ms - a.ms)]));
}

// --- cover art (ES-DE's scraped media, next to its ROM folders)

export const MEDIA_DIR = process.env.LUMA_MEDIA_DIR || "G:\\ES-DE\\downloaded_media";
const ART_KINDS = ["covers", "miximages", "screenshots"];
const ART_TYPES = [".png", ".jpg", ".jpeg", ".webp"];

/** ES-DE's picture for this play: media\<system>\<kind>\<same folders and
 * name as the ROM>.<png|jpg>. Null when it has none. */
export function coverFile(play: Pick<GamePlay, "rom" | "system">, mediaDir = MEDIA_DIR): string | null {
  if (!play.rom) return null;
  const m = /\\ROMs\\([^\\]+)\\(.+)$/i.exec(play.rom);
  if (!m) return null;
  const system = m[1];
  const rel = m[2].replace(/\.[^.\\]+$/, "");
  // (never outside the media folder, whatever the ROM path says)
  if ([system, ...rel.split(/[\\/]/)].some((part) => part === ".." || part === ".")) return null;
  for (const kind of ART_KINDS) {
    for (const ext of ART_TYPES) {
      const file = path.join(mediaDir, system, kind, rel + ext);
      if (existsSync(file)) return file;
    }
  }
  return null;
}

export function playById(id: number): GamePlay | null {
  const row = getDb().prepare("SELECT * FROM game_plays WHERE id = ?").get(id) as Row | undefined;
  return row ? toPlay(row) : null;
}
