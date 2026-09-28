import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

// The per-player saves script (host/profiles.ps1), for the jobs LumaArcade
// hands it: snapshots (routes/saves.ts) and giving a guest link's saves to a
// new account (guestLinks.ts). It prints one line of JSON.

// LUMA_PROFILES_SCRIPT points it elsewhere (tests: somewhere that doesn't
// exist, so they never touch the real saves).
export const PROFILES_SCRIPT = process.env.LUMA_PROFILES_SCRIPT || "C:\\ProgramData\\LumaArcade\\profiles.ps1";

export function profilesInstalled(): boolean {
  return existsSync(PROFILES_SCRIPT);
}

export async function runProfiles(args: string[]): Promise<Record<string, unknown>> {
  let stdout = "";
  try {
    ({ stdout } = await run(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PROFILES_SCRIPT, ...args],
      { windowsHide: true, timeout: 180_000 }
    ));
  } catch (err) {
    // It exits 1 with {"error": ...} on stdout for refusals.
    stdout = (err as { stdout?: string }).stdout ?? "";
    if (!stdout.trim()) throw new Error((err as Error).message);
  }
  const line = stdout.trim().split(/\r?\n/).at(-1) ?? "";
  return JSON.parse(line) as Record<string, unknown>;
}
