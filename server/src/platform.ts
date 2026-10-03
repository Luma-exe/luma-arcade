import os from "node:os";
import path from "node:path";

// Which OS the gaming PC runs. Windows is the full product; Linux support is
// in very early testing: streaming, accounts, turns, co-op and guest links
// share Windows' code, while the PC-side helpers (Home button, lockdown,
// per-player saves, game tracking, PC games import) are Windows-only for
// now. See docs/linux-host-plan.md.

export const IS_WINDOWS = process.platform === "win32";
export const IS_LINUX = process.platform === "linux";

/** Where the PC-side helpers and their state live: C:\ProgramData\LumaArcade
 * on Windows (installer/scripts/install-host.ps1), ~/.local/share/luma-arcade
 * on Linux. LUMA_DATA_DIR overrides it. */
export const DATA_DIR =
  process.env.LUMA_DATA_DIR ||
  (IS_WINDOWS
    ? "C:\\ProgramData\\LumaArcade"
    : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "luma-arcade"));

export function dataPath(...parts: string[]): string {
  return path.join(DATA_DIR, ...parts);
}

/** moonlight-web-stream's server program. */
export const MOONLIGHT_BINARY = IS_WINDOWS ? "web-server.exe" : "web-server";

/** Opens a page in the default browser (the one signed in on this PC). */
export function openCommand(url: string): string {
  if (IS_WINDOWS) return `start ${url}`;
  if (process.platform === "darwin") return `open ${url}`;
  return `xdg-open ${url}`;
}

/** Why a Windows-only feature isn't there, for errors shown to people. */
export const WINDOWS_ONLY = "Not available on Linux yet (Linux support is in early testing)";
