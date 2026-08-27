import { ManagedProcess } from "../process/managedProcess.js";
import { getSetting } from "../config/settings.js";

/** Shared between here (the launch args) and web/routes/moonlight.ts (the
 * reverse-proxy prefix) so the two can't drift out of sync — they did once,
 * when this file passed a plain --port flag moonlight-web-stream doesn't
 * have and the prefix was hardcoded separately in the route file. */
export const MOONLIGHT_PATH_PREFIX = "/stream";

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
  const path = getSetting("moonlightWebStreamPath");
  const port = getSetting("moonlightWebStreamPort");

  if (enabled && path) {
    if (!moonlightProcess.isRunning()) {
      // Confirmed against the real moonlight-web-stream CLI (`--help`):
      // there is no --port flag, only --bind-address (host:port) and
      // --path-prefix. The previous ["--port", ...] args were silently
      // wrong — the process either failed to start or ignored the flag
      // depending on build, which is why this had to be launched manually
      // outside LumaArcade on at least one real deployment.
      moonlightProcess.start([
        "--bind-address",
        `127.0.0.1:${port}`,
        "--path-prefix",
        MOONLIGHT_PATH_PREFIX,
      ]);
    }
  } else {
    moonlightProcess.stop();
  }
}
