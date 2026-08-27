import type { FastifyInstance } from "fastify";
import fastifyHttpProxy from "@fastify/http-proxy";
import { getSetting } from "../../config/settings.js";
import { requireAuth } from "../session.js";
import { moonlightProcess, MOONLIGHT_PATH_PREFIX } from "../../remote/moonlightWebStream.js";

const PROXY_PREFIX = MOONLIGHT_PATH_PREFIX;

/** Reverse-proxies everything under /stream to the locally-run
 * moonlight-web-stream process, behind the same session-cookie auth gate as
 * every other route — see remote/moonlightWebStream.ts for how that process
 * is started/stopped. websocket: true forwards its own
 * WebSocket/WebRTC-signalling traffic too. */
export async function registerMoonlightRoutes(app: FastifyInstance) {
  // Bound once at server startup, same as the main listen port — changing
  // moonlightWebStreamPort in Settings requires a LumaArcade restart to
  // take effect on the proxy target.
  const port = getSetting("moonlightWebStreamPort");

  await app.register(fastifyHttpProxy, {
    upstream: `http://127.0.0.1:${port}`,
    prefix: PROXY_PREFIX,
    websocket: true,
    preHandler: requireAuth,
  });

  app.get(
    "/api/moonlight/status",
    { preHandler: requireAuth },
    async (): Promise<{ reachable: boolean; processRunning: boolean; lastError?: string }> => {
      const processRunning = moonlightProcess.isRunning();
      const lastError = moonlightProcess.getLastError();

      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(1500),
        });
        return { reachable: res.ok || res.status < 500, processRunning, lastError };
      } catch {
        // Distinguish "we never even started it" / "it crashed and hasn't
        // come back yet" from "it's running but not answering HTTP" —
        // reachable:false alone used to look identical for all three, which
        // made this endpoint useless for actually diagnosing a stuck stream.
        return { reachable: false, processRunning, lastError };
      }
    }
  );
}
