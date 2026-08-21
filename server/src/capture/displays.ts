import { spawn } from "node:child_process";

export interface DisplayInfo {
  index: number;
  width: number;
  height: number;
  primary: boolean;
}

/** Lists physical displays in the same order Electron's desktopCapturer
 * enumerates screen sources in (both ultimately walk the OS's own display
 * list), so `index` here lines up with the `--monitor-index` producer-
 * electron/main.js expects. */
export function listDisplays(): Promise<DisplayInfo[]> {
  return new Promise((resolve) => {
    const ps = spawn("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; " +
        "[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { " +
        '"$($_.Bounds.Width),$($_.Bounds.Height),$($_.Primary)" }',
    ]);
    let out = "";
    ps.stdout.on("data", (d) => (out += d.toString()));
    ps.on("close", () => {
      const displays = out
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line, index) => {
          const [width, height, primary] = line.trim().split(",");
          return { index, width: Number(width), height: Number(height), primary: primary === "True" };
        });
      resolve(displays.length > 0 ? displays : [{ index: 0, width: 0, height: 0, primary: true }]);
    });
    ps.on("error", () => resolve([{ index: 0, width: 0, height: 0, primary: true }]));
  });
}
