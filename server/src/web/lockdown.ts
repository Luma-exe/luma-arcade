import { writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import type { FastifyBaseLogger } from "fastify";
import { connectedUsers } from "./sessions.js";
import type { StreamUser } from "./streamUser.js";
import { dataPath } from "../platform.js";

// While anyone without the admin role is streaming, the PC's admin tools
// (File Explorer, Task Manager, Settings, browsers, Disk Management...)
// are closed the moment they open: moonlight host/lockdown.ps1, run on the
// Arcade desktop by the scheduled task \LumaArcade\Lockdown. This decides
// when, and tells it through a state file it re-reads every second. The
// state expires HOLD_MS after it was last written, so if LumaArcade stops,
// the PC unlocks by itself instead of staying locked.

export const STATE_FILE = process.env.LUMA_LOCKDOWN_FILE || dataPath("home", "lockdown.json");
const TASK = "\\LumaArcade\\Lockdown";
const TICK_MS = 2000;
const HOLD_MS = 60_000;
/** Start the task again this often while locked (a second copy exits at once). */
const RESTART_TASK_MS = 30_000;

/** Who the PC is locked down for right now (nobody: not locked). */
export function lockedFor(users: StreamUser[]): StreamUser[] {
  return users.filter((u) => !u.admin);
}

export interface LockdownState {
  on: boolean;
  until: number;
  who: string;
}

export function lockdownState(users: StreamUser[], now = Date.now()): LockdownState {
  const locked = lockedFor(users);
  return { on: locked.length > 0, until: now + HOLD_MS, who: locked.map((u) => u.name).join(", ") };
}

let timer: NodeJS.Timeout | null = null;

export function startLockdown(log: FastifyBaseLogger): void {
  if (timer) return;
  let wasOn = false;
  let lastTaskRun = 0;
  const write = (state: LockdownState) => {
    try {
      writeFileSync(STATE_FILE, JSON.stringify(state));
    } catch (err) {
      log.warn({ err }, "couldn't write the lockdown state");
    }
  };
  const runTask = () =>
    execFile("schtasks.exe", ["/run", "/tn", TASK], { windowsHide: true, timeout: 10_000 }, (err) => {
      if (err) log.warn({ err: err.message }, "couldn't start the lockdown task");
    });
  write({ on: false, until: 0, who: "" });
  const tick = () => {
    const now = Date.now();
    const state = lockdownState(connectedUsers(), now);
    if (state.on) {
      write(state);
      if (!wasOn) log.info({ who: state.who }, "lockdown on: admin tools closed on sight");
      if (!wasOn || now - lastTaskRun >= RESTART_TASK_MS) {
        lastTaskRun = now;
        runTask();
      }
    } else if (wasOn) {
      write(state);
      log.info("lockdown off");
    }
    wasOn = state.on;
  };
  timer = setInterval(tick, TICK_MS);
  timer.unref();
}
