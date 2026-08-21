import { spawn } from "node:child_process";

export interface MainWindowInfo {
  hwnd: string;
  title: string;
}

function queryMainWindow(pid: number): Promise<MainWindowInfo | undefined> {
  return new Promise((resolve) => {
    const ps = spawn("powershell.exe", [
      "-NoProfile",
      "-Command",
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { "$($p.MainWindowHandle)|$($p.MainWindowTitle)" }`,
    ]);
    let out = "";
    ps.stdout.on("data", (d) => (out += d.toString()));
    ps.on("close", () => {
      const [hwndRaw, ...titleParts] = out.trim().split("|");
      const hwnd = Number(hwndRaw);
      const title = titleParts.join("|").trim();
      resolve(hwnd > 0 && title ? { hwnd: String(hwnd), title } : undefined);
    });
    ps.on("error", () => resolve(undefined));
  });
}

/**
 * Polls until the process has a main window with a title (games/emulators
 * often take a few seconds to create their render window after the process
 * starts, and Chromium's --auto-select-desktop-capture-source needs a
 * non-empty title to match against), or gives up. Returns undefined on
 * timeout — callers should fall back to full-desktop capture rather than
 * fail the whole launch.
 */
export async function waitForMainWindow(
  pid: number,
  opts: { attempts?: number; intervalMs?: number } = {}
): Promise<MainWindowInfo | undefined> {
  const attempts = opts.attempts ?? 30;
  const intervalMs = opts.intervalMs ?? 500;

  for (let i = 0; i < attempts; i++) {
    const info = await queryMainWindow(pid);
    if (info) return info;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return undefined;
}
