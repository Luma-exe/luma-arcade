import { ManagedProcess } from "../process/managedProcess.js";
import { getSetting } from "../config/settings.js";

export const cloudflaredProcess = new ManagedProcess("cloudflared", "cloudflared");

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
