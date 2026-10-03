import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { HealthCheck } from "./routes/health.js";

// This PC's Steam and Epic games in ES-DE: host/sync-pc-games.ps1 does the
// work as the games account (scheduled task \LumaArcade\PC Games, at sign-in
// and early each morning) and leaves its result in pc-games.json. Host
// health shows it, with "Import now".

const run = promisify(execFile);

export const PC_GAMES_TASK = "\\LumaArcade\\PC Games";
export const PC_GAMES_STATUS = process.env.LUMA_PC_GAMES_STATUS || "C:\\ProgramData\\LumaArcade\\home\\pc-games.json";
export const IMPORT_PC_GAMES = { id: "import-pc-games", label: "Import now" };

export interface PcGamesStatus {
  at?: string;
  steam?: number;
  epic?: number;
  added?: string[];
  removed?: string[];
  waiting?: string | null;
  error?: string;
}

export function readPcGamesStatus(file = PC_GAMES_STATUS): PcGamesStatus | null {
  try {
    // (PowerShell 5 writes UTF-8 with a byte order mark)
    return JSON.parse(readFileSync(file, "utf-8").replace(/^\uFEFF/, "")) as PcGamesStatus;
  } catch {
    return null;
  }
}

function ago(iso: string, now: number): string {
  const min = Math.round((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(min)) return "";
  if (min < 2) return "just now";
  if (min < 120) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`;
}

export function pcGamesCheck(status: PcGamesStatus | null, hasTask: boolean, now = Date.now()): HealthCheck {
  const base = { id: "pc-games", label: "PC games", action: hasTask ? IMPORT_PC_GAMES : undefined };
  if (!hasTask) {
    return { ...base, status: "warn", detail: "Steam and Epic games aren't imported into ES-DE automatically - run Setup again to set it up" };
  }
  if (!status) return { ...base, status: "warn", detail: "Not imported yet - it runs when the games account signs in, or press Import now" };
  const when = status.at ? ` (${ago(status.at, now)})` : "";
  if (status.error) return { ...base, status: "warn", detail: `The last import failed${when}: ${status.error}` };
  const counts = `${status.steam ?? 0} Steam and ${status.epic ?? 0} Epic games in ES-DE`;
  if (status.waiting) return { ...base, status: "ok", detail: `${counts}; waiting: ${status.waiting}` };
  const changes = [
    status.added?.length ? `added ${status.added.join(", ")}` : "",
    status.removed?.length ? `removed ${status.removed.join(", ")}` : "",
  ].filter(Boolean);
  return { ...base, status: "ok", detail: `${counts}, checked${when}${changes.length ? `: ${changes.join("; ")}` : ""}` };
}

export async function checkPcGames(): Promise<HealthCheck> {
  let hasTask = false;
  try {
    const { stdout } = await run("schtasks.exe", ["/query", "/tn", PC_GAMES_TASK, "/fo", "LIST"], { windowsHide: true, timeout: 5000 });
    hasTask = /TaskName:/i.test(stdout);
  } catch {}
  return pcGamesCheck(readPcGamesStatus(), hasTask);
}

/** "Import now": runs the task on the games desktop. */
export async function importPcGames(): Promise<void> {
  await run("schtasks.exe", ["/run", "/tn", PC_GAMES_TASK], { windowsHide: true, timeout: 5000 });
}
