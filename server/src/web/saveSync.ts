import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { runProfiles } from "./profilesScript.js";
import type { Seat } from "./seats.js";
import { dataPath } from "../platform.js";
import { askManager, managerInstalled } from "./seatManager.js";

const run = promisify(execFile);

// A player's saves follow them between PCs: the main PC and the extra seats
// (seats.ts) each keep everyone's saves (host/profiles.ps1), and this
// remembers where each player last played. When someone starts on a PC that
// isn't that one, their PC's switch asks here first (POST /api/saves/arrive):
// the last PC exports their saves, they're copied over, and the switch
// imports them before loading them - so whichever PC they're on, it has their
// latest. Seats are VMs on this PC, reached through PowerShell Direct: by the
// seat manager (host/seat-manager.ps1, as SYSTEM) where Setup installed it,
// else straight from here (host/seat-sync.ps1, when Luma Arcade runs as an
// administrator).

/** The main PC, as a "where they last played". Seats go by their name. */
export const MAIN = "main";
const HOME_FILE = process.env.LUMA_SAVES_HOME || dataPath("saves-home.json");
/** The main PC's exports (the seat manager copies them from here). */
const STAGING = process.env.LUMA_SAVES_STAGING || dataPath("sync-out");
/** Where a seat keeps a player's saves on the move. */
const SEAT_DIR = dataPath("sync");
const SEAT_SYNC_SCRIPT = process.env.LUMA_SEAT_SYNC_SCRIPT || dataPath("seat-sync.ps1");

export interface Player {
  id: number;
  name: string;
}

export interface SyncDeps {
  readHome(): Record<string, string>;
  writeHome(home: Record<string, string>): void;
  /** On the main PC: the player's saves into dir. */
  exportMain(player: Player, dir: string): Promise<void>;
  /** On a seat: the player's saves, copied to this PC - into hostDir, or
   * the folder it returns (the seat manager picks its own). */
  exportSeat(seat: Seat, player: Player, hostDir: string): Promise<string | void>;
  /** hostDir copied onto the seat at seatDir. */
  toSeat(seat: Seat, player: Player, hostDir: string, seatDir: string): Promise<void>;
  /** The folder becomes the player's saves on that PC (its profiles.ps1
   * -Action import): on the main PC, or (copied there first) on a seat. */
  importMain(player: Player, dir: string): Promise<void>;
  importSeat(seat: Seat, player: Player, hostDir: string, seatDir: string): Promise<void>;
}

/** The seat VM's sign-in: the seat manager's, or Seat2's (set up by hand). */
function credFile(seat: Seat): string {
  const managed = dataPath("seats", seat.name, "credentials.json");
  if (existsSync(managed)) return managed;
  return path.join("E:\\HyperV", seat.name, `${seat.name.toLowerCase()}-credentials.json`);
}

/** A move done by the seat manager. Returns the folder it used on this PC. */
async function viaManager(mode: "export" | "import" | "apply", seat: Seat, player: Player, from?: string): Promise<string> {
  const answer = await askManager("sync", { name: seat.name, mode, playerId: player.id, playerName: player.name, from }, 600_000);
  return String(answer.dir ?? "");
}

async function seatSync(mode: "export" | "import" | "apply", seat: Seat, player: Player, seatDir: string, hostDir: string) {
  let stdout = "";
  try {
    ({ stdout } = await run(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SEAT_SYNC_SCRIPT, "-Mode", mode, "-VmName", seat.name,
        "-CredFile", credFile(seat), "-Player", `${player.id}:${player.name}`, "-SeatDir", seatDir, "-HostDir", hostDir],
      { windowsHide: true, timeout: 600_000 }
    ));
  } catch (err) {
    stdout = (err as { stdout?: string }).stdout ?? "";
    if (!stdout.trim()) throw new Error((err as Error).message);
  }
  const answer = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "{}") as { ok?: boolean; error?: string };
  if (!answer.ok) throw new Error(answer.error ?? `${mode} on ${seat.name} failed`);
}

const realDeps: SyncDeps = {
  readHome: () => {
    try {
      return JSON.parse(readFileSync(HOME_FILE, "utf8").replace(/^\uFEFF/, "")) as Record<string, string>;
    } catch {
      return {};
    }
  },
  writeHome: (home) => writeFileSync(HOME_FILE, JSON.stringify(home, null, 2)),
  exportMain: async (player, dir) => {
    mkdirSync(path.dirname(dir), { recursive: true });
    const answer = await runProfiles(["-Action", "export", "-Player", `${player.id}:${player.name}`, "-Dir", dir]);
    if (answer.error) throw new Error(String(answer.error));
  },
  exportSeat: async (seat, player, hostDir) => {
    if (managerInstalled()) return viaManager("export", seat, player);
    mkdirSync(path.dirname(hostDir), { recursive: true });
    await seatSync("export", seat, player, path.win32.join(SEAT_DIR, `user-${player.id}`), hostDir);
  },
  toSeat: async (seat, player, hostDir, seatDir) => {
    if (managerInstalled()) return void (await viaManager("import", seat, player, hostDir));
    await seatSync("import", seat, player, seatDir, hostDir);
  },
  importMain: async (player, dir) => {
    const answer = await runProfiles(["-Action", "import", "-Player", `${player.id}:${player.name}`, "-Dir", dir]);
    if (answer.error) throw new Error(String(answer.error));
  },
  importSeat: async (seat, player, hostDir, seatDir) => {
    if (managerInstalled()) return void (await viaManager("apply", seat, player, hostDir));
    await seatSync("apply", seat, player, seatDir, hostDir);
  },
};

let deps: SyncDeps = realDeps;
/** Moves handed out, waiting for the PC to say it imported them. */
const pending = new Map<number, string>();
/** One move at a time per player. */
const queues = new Map<number, Promise<unknown>>();

/** Tests. */
export function setSyncDeps(next: SyncDeps | null): void {
  deps = next ?? realDeps;
  pending.clear();
  queues.clear();
}

/** Where this player last played (their latest saves are there). */
export function lastPc(userId: number): string {
  return deps.readHome()[String(userId)] ?? MAIN;
}

/** Their latest saves are on another PC than this one. */
export function savesElsewhere(userId: number, pc: string): boolean {
  return lastPc(userId) !== pc;
}

/**
 * A PC's switch is about to load this player's saves. If they last played
 * elsewhere, those saves are exported there and brought to this PC: the
 * answer names the folder (on the asking PC) to import. seats: the extra
 * seats there are (seats.ts listSeats).
 */
export function arrive(player: Player, pc: string, seats: Seat[]): Promise<{ import?: string; from?: string }> {
  const previous = queues.get(player.id) ?? Promise.resolve();
  const job = previous.catch(() => {}).then(async () => {
    const last = lastPc(player.id);
    if (last === pc) return {};
    const seatNamed = (name: string) => seats.find((s) => s.name === name) ?? null;
    let hostDir = path.win32.join(STAGING, `user-${player.id}`);
    if (last === MAIN) {
      await deps.exportMain(player, hostDir);
    } else {
      const from = seatNamed(last);
      // That seat is gone: nothing to fetch, this PC's copy is the one now.
      if (!from) return {};
      hostDir = (await deps.exportSeat(from, player, hostDir)) || hostDir;
    }
    pending.set(player.id, pc);
    if (pc === MAIN) return { import: hostDir, from: last };
    const to = seatNamed(pc);
    if (!to) throw new Error(`No seat called ${pc}`);
    const seatDir = path.win32.join(SEAT_DIR, `user-${player.id}`);
    await deps.toSeat(to, player, hostDir, seatDir);
    return { import: seatDir, from: last };
  });
  queues.set(player.id, job);
  return job;
}

/**
 * The whole move, before the player connects (the stream page waits on it,
 * POST /api/saves/fetch): their latest saves exported where they last
 * played, copied over and imported on this PC. Afterwards arrive() has
 * nothing to do. moved: false when they were here already.
 */
export function fetchTo(player: Player, pc: string, seats: Seat[]): Promise<{ moved: boolean; from?: string }> {
  const previous = queues.get(player.id) ?? Promise.resolve();
  const job = previous.catch(() => {}).then(async () => {
    const last = lastPc(player.id);
    if (last === pc) return { moved: false };
    const seatNamed = (name: string) => seats.find((s) => s.name === name) ?? null;
    let hostDir = path.win32.join(STAGING, `user-${player.id}`);
    if (last === MAIN) {
      await deps.exportMain(player, hostDir);
    } else {
      const from = seatNamed(last);
      if (!from) {
        setLastPc(player.id, pc);
        return { moved: false };
      }
      hostDir = (await deps.exportSeat(from, player, hostDir)) || hostDir;
    }
    if (pc === MAIN) {
      await deps.importMain(player, hostDir);
    } else {
      const to = seatNamed(pc);
      if (!to) throw new Error(`No seat called ${pc}`);
      await deps.importSeat(to, player, hostDir, path.win32.join(SEAT_DIR, `user-${player.id}`));
    }
    setLastPc(player.id, pc);
    return { moved: true, from: last };
  });
  queues.set(player.id, job);
  return job;
}

/** The PC imported (or failed to import) what arrive() handed it. */
export function arrived(userId: number, pc: string, ok: boolean): void {
  const waiting = pending.get(userId);
  pending.delete(userId);
  if (!ok || waiting !== pc) return;
  setLastPc(userId, pc);
}

/** This player's saves are loaded on this PC now (nothing had to move). */
export function setLastPc(userId: number, pc: string): void {
  const home = deps.readHome();
  if (home[String(userId)] === pc) return;
  home[String(userId)] = pc;
  if (pc === MAIN) delete home[String(userId)];
  try {
    if (!existsSync(path.dirname(HOME_FILE))) mkdirSync(path.dirname(HOME_FILE), { recursive: true });
  } catch {}
  deps.writeHome(home);
}
