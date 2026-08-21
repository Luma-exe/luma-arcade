import path from "node:path";
import { ManagedProcess } from "../process/managedProcess.js";
import { getSetting } from "../config/settings.js";

/** moonlight-web-stream (github.com/MrCreativ3001/moonlight-web-stream) is a
 * separately-built/installed Rust+web server that speaks the Moonlight
 * protocol to a Sunshine host and serves its own browser client. It isn't a
 * library we can import — LumaArcade manages it as a child process (same
 * pattern the old cloudflared/coturn integration used) and reverse-proxies
 * to it once it's up, see web/routes/moonlight.ts. */
export const moonlightProcess = new ManagedProcess(
  () => getSetting("moonlightWebStreamPath"),
  "moonlight-web-stream"
);

export function syncMoonlightWithSettings(): void {
  const enabled = getSetting("moonlightAutoStart");
  const exePath = getSetting("moonlightWebStreamPath");
  const port = getSetting("moonlightWebStreamPort");

  if (enabled && exePath) {
    if (!moonlightProcess.isRunning()) {
      moonlightProcess.start(
        [
          // Bound to loopback only — the /stream reverse proxy (see
          // web/routes/moonlight.ts) is meant to be the only public entry
          // point. moonlight-web-stream's own default (0.0.0.0) would
          // otherwise expose its unauthenticated first-run admin signup
          // directly to the network, bypassing LumaArcade's auth gate
          // entirely — confirmed live during setup, not a hypothetical.
          "--bind-address",
          `127.0.0.1:${port}`,
          // Its frontend generates absolute-path links (e.g.
          // /api/authenticate) that must match where the /stream proxy
          // actually mounts it, or those requests 404 against LumaArcade's
          // own root instead — also confirmed live, not a hypothetical.
          "--path-prefix",
          "/stream",
        ],
        // moonlight-web-stream resolves its config/data/streamer paths
        // relative to its own working directory (./server/config.json,
        // ./streamer by default) — without this it'd resolve those against
        // LumaArcade's cwd instead and fail to find anything.
        { cwd: path.dirname(exePath) }
      );
    }
  } else {
    moonlightProcess.stop();
  }
}
