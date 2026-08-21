import { existsSync } from "node:fs";
import path from "node:path";
import { ManagedProcess } from "../process/managedProcess.js";
import { getSetting } from "../config/settings.js";

// Same PATH-staleness issue as GStreamer (see gstProcess.ts): a winget
// install made during this same boot won't be visible to bare `cloudflared`
// PATH lookup until a fresh login session. Probe the actual winget install
// location directly and fall back to PATH lookup.
const CANDIDATE_DIRS = [
  "C:\\Program Files (x86)\\cloudflared",
  "C:\\Program Files\\cloudflared",
  path.join(process.env.LOCALAPPDATA ?? "", "Programs", "cloudflared"),
];

function resolveCloudflared(): string {
  for (const dir of CANDIDATE_DIRS) {
    const candidate = path.join(dir, "cloudflared.exe");
    if (existsSync(candidate)) return candidate;
  }
  return "cloudflared"; // fall back to PATH lookup
}

export const cloudflaredProcess = new ManagedProcess(resolveCloudflared, "cloudflared");

export function syncCloudflaredWithSettings(): void {
  const enabled = getSetting("remoteAccessEnabled");
  const token = getSetting("cloudflareTunnelToken");

  if (enabled && token) {
    if (!cloudflaredProcess.isRunning()) {
      cloudflaredProcess.start(["tunnel", "run", "--token", token]);
    }
  } else {
    cloudflaredProcess.stop();
  }
}
