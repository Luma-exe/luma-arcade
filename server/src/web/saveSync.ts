import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { runProfiles } from "./profilesScript.js";
import type { Seat } from "./seats.js";

const run = promisify(execFile);

// A player's saves follow them between PCs: the main PC and the extra seats
// (seats.ts) each keep everyone's saves (host/profiles.ps1), and this
// remembers where each player last played. When someone starts on a PC that
// isn't that one, their PC's switch asks here first (POST /api/saves/arrive):
// the last PC exports their saves, they're copied over, and the switch
// imports them before loading them - so whichever PC they're on, it has their
// latest. Seats are VMs on this PC, reached through PowerShell Direct
// (host/seat-sync.ps1).

/** The main PC, as a "where they last played". Seats go by their name. */
export const MAIN = "main";
const HOME_FILE = process.env.LUMA_SAVES_HOME || "C:\\ProgramData\\LumaArcade\\saves-home.json";
const STAGING = process.env.LUMA_SAVES_STAGING || "E:\\LumaArcade\\sync";
/** Where a seat keeps a player's saves on the move. */
const SEAT_DIR = "C:\\ProgramData\\LumaArcade\\sync";
const SEAT_SYNC_SCRIPT = process.env.LUMA_SEAT_SYNC_SCRIPT || "C:\\ProgramData\\LumaArcade\\seat-sync.ps1";

export interface Player {
  id: number;
  name: string;
}

export interface SyncDeps {
  readHome(): Record<string, string>;
  writeHome(home: Record<string, string>): void;
  /** On the main PC: the player's saves into dir. */
  exportMain(player: Player, dir: string): Promise<void>;
  /** On a seat: the player's saves, copied here to hostDir. */
  exportSeat(seat: Seat, player: Player, hostDir: string): Promise<void>;
  /** hostDir copied onto the seat at seatDir. */
  toSeat(seat: Seat, player: Player, hostDir: string, seatDir: string): Promise<void>;
}

/** The seat VM's sign-in, made when it was set up. */
function credFile(seat: Seat): string {
  return path.join("E:\\HyperV", seat.name, `${seat.name.toLowerCase()}-credentials.json`);
}

async function seatSync(mode: "export" | "import", seat: Seat, player: Player, seatDir: string, hostDir: string) {
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
    mkdirSync(path.dirname(hostDir), { recursive: true });
    await seatSync("export", seat, player, path.win32.join(SEAT_DIR, `user-${player.id}`), hostDir);
  },
  toSeat: (seat, player, hostDir, seatDir) => seatSync("import", seat, player, seatDir, hostDir),
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
    const hostDir = path.win32.join(STAGING, `user-${player.id}`);
    if (last === MAIN) {
      await deps.exportMain(player, hostDir);
    } else {
      const from = seatNamed(last);
      // That seat is gone: nothing to fetch, this PC's copy is the one now.
      if (!from) return {};
      await deps.exportSeat(from, player, hostDir);
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
