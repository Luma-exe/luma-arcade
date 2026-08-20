import { spawn } from "node:child_process";

function queryMainWindowHandle(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const ps = spawn("powershell.exe", [
      "-NoProfile",
      "-Command",
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).MainWindowHandle`,
    ]);
    let out = "";
    ps.stdout.on("data", (d) => (out += d.toString()));
    ps.on("close", () => {
      const hwnd = Number(out.trim());
      resolve(hwnd > 0 ? String(hwnd) : undefined);
    });
    ps.on("error", () => resolve(undefined));
  });
}

/**
 * Polls until the process has a main window (games/emulators often take a
 * few seconds to create their render window after the process starts), or
 * gives up. Returns undefined on timeout — callers should fall back to
 * full-desktop capture rather than fail the whole launch.
 */
export async function waitForMainWindow(
  pid: number,
  opts: { attempts?: number; intervalMs?: number } = {}
): Promise<string | undefined> {
  const attempts = opts.attempts ?? 30;
  const intervalMs = opts.intervalMs ?? 500;

  for (let i = 0; i < attempts; i++) {
    const hwnd = await queryMainWindowHandle(pid);
    if (hwnd) return hwnd;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return undefined;
}
