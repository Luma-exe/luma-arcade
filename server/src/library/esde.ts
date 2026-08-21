import { spawn } from "node:child_process";
import path from "node:path";
import { getSetting } from "../config/settings.js";
import { waitForMainWindow } from "../capture/windowTracker.js";
import { spawnDetached } from "./processUtils.js";

export interface EsdeLaunchResult {
  ok: boolean;
  error?: string;
  pid?: number;
  alreadyRunning?: boolean;
}

/** Checks for an already-running instance by process name (the exe's own
 * basename, without extension) so re-entering ES-DE mode attaches to an
 * existing session instead of spawning a duplicate. */
function findRunningPid(exeBaseName: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const ps = spawn("powershell.exe", [
      "-NoProfile",
      "-Command",
      `(Get-Process -Name "${exeBaseName}" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id)`,
    ]);
    let out = "";
    ps.stdout.on("data", (d) => (out += d.toString()));
    ps.on("close", () => {
      const pid = Number(out.trim());
      resolve(pid > 0 ? pid : undefined);
    });
    ps.on("error", () => resolve(undefined));
  });
}

const SW_RESTORE = 9;

/** Restores (un-minimizes) and focuses the given window -- without this,
 * "attaching" to an already-running ES-DE just resolved its pid and did
 * nothing else, so an ES-DE left minimized (or simply not focused, e.g.
 * after Alt-Tabbing away) stayed that way forever: the video producer would
 * either capture a black/frozen minimized window or silently fall back to
 * full-desktop capture (see producer-electron/main.js), and keyboard/mouse
 * input injected via /input landed on whatever *was* focused instead of
 * ES-DE -- both observed as "back to ES-DE does nothing" and "can't move
 * the mouse", despite input injection itself working correctly. */
function focusAndRestore(hwnd: string): Promise<void> {
  return new Promise((resolve) => {
    const ps = spawn("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; " +
        "public class LumaWin32 { " +
        "[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); " +
        "[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); }'; " +
        `[LumaWin32]::ShowWindow([IntPtr]${hwnd}, ${SW_RESTORE}) | Out-Null; ` +
        `[LumaWin32]::SetForegroundWindow([IntPtr]${hwnd}) | Out-Null`,
    ]);
    ps.on("close", () => resolve());
    ps.on("error", () => resolve());
  });
}

export async function launchOrAttachEsde(): Promise<EsdeLaunchResult> {
  const exePath = getSetting("esdeExePath");
  if (!exePath) {
    return { ok: false, error: "No ES-DE executable path configured in Settings." };
  }

  const baseName = path.basename(exePath, path.extname(exePath));
  const existingPid = await findRunningPid(baseName);

  if (existingPid) {
    const mainWindow = await waitForMainWindow(existingPid, { attempts: 6, intervalMs: 250 });
    if (mainWindow) await focusAndRestore(mainWindow.hwnd);
    return { ok: true, pid: existingPid, alreadyRunning: true };
  }

  // True exclusive fullscreen (ES-DE's default "Screen mode: fullscreen",
  // confirmed via its own es_log.txt) renders straight to the GPU without
  // ever going through DWM's composition surface -- both Windows.Graphics
  // .Capture (what the video producer uses) and plain GDI BitBlt can only
  // see black for a window in that mode, no matter how correctly it's
  // otherwise sized/focused/foregrounded. A guessed --fullscreen-borderless
  // flag crashed ES-DE outright rather than fixing this (wrong flag syntax),
  // so this needs to be set from ES-DE's own UI (Other Settings > some
  // display/screen-mode option) or its exact documented CLI flag confirmed
  // before scripting it here -- not guessed at blind.
  const child = spawnDetached(exePath, []);
  if (child.pid) {
    const mainWindow = await waitForMainWindow(child.pid);
    if (mainWindow) await focusAndRestore(mainWindow.hwnd);
  }
  return { ok: true, pid: child.pid, alreadyRunning: false };
}
