import { existsSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import path from "node:path";

export type DependencyId = "gstreamer" | "vigembus" | "cloudflared";

export interface DependencyStatus {
  id: DependencyId;
  label: string;
  installed: boolean;
  wingetId: string;
}

const GSTREAMER_DIRS = [
  "C:\\gstreamer\\1.0\\msvc_x86_64\\bin",
  path.join(process.env.LOCALAPPDATA ?? "", "Programs", "gstreamer", "1.0", "msvc_x86_64", "bin"),
  "C:\\Program Files\\gstreamer\\1.0\\msvc_x86_64\\bin",
];

const CLOUDFLARED_DIRS = [
  "C:\\Program Files (x86)\\cloudflared",
  "C:\\Program Files\\cloudflared",
  path.join(process.env.LOCALAPPDATA ?? "", "Programs", "cloudflared"),
];

function existsInAnyDir(dirs: string[], exeName: string): boolean {
  return dirs.some((dir) => existsSync(path.join(dir, exeName)));
}

function checkViGEmBus(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "reg",
      ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Services\\ViGEmBus"],
      (err) => resolve(!err)
    );
  });
}

export async function checkDependencies(): Promise<DependencyStatus[]> {
  const vigemInstalled = await checkViGEmBus();
  return [
    {
      id: "gstreamer",
      label: "GStreamer (video capture/encode pipeline)",
      installed: existsInAnyDir(GSTREAMER_DIRS, "gst-launch-1.0.exe"),
      wingetId: "gstreamerproject.gstreamer",
    },
    {
      id: "vigembus",
      label: "ViGEmBus (virtual controller driver)",
      installed: vigemInstalled,
      wingetId: "ViGEm.ViGEmBus",
    },
    {
      id: "cloudflared",
      label: "cloudflared (remote access tunnel)",
      installed: existsInAnyDir(CLOUDFLARED_DIRS, "cloudflared.exe"),
      wingetId: "Cloudflare.cloudflared",
    },
  ];
}

/** Fire-and-forget: winget installs can take minutes (GStreamer's package
 * alone is 800MB+), far too long to hold an HTTP request open for. Callers
 * should re-run checkDependencies() later (the "Rescan" button) to see
 * whether it finished. */
export function installDependency(wingetId: string): void {
  const child = spawn(
    "winget",
    [
      "install",
      "--id",
      wingetId,
      "-e",
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--silent",
    ],
    { windowsHide: true, detached: true }
  );
  child.stdout?.on("data", (chunk) => process.stdout.write(`[deps:${wingetId}] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[deps:${wingetId}] ${chunk}`));
  child.on("error", (err) => console.error(`[deps:${wingetId}] failed to start winget:`, err.message));
  child.unref();
}
