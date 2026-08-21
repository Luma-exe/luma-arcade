import type { FastifyInstance } from "fastify";
import fastifyHttpProxy from "@fastify/http-proxy";
import { getSetting } from "../../config/settings.js";
import { requireAuth } from "../session.js";

const PROXY_PREFIX = "/stream";

/** Reverse-proxies everything under /stream to the locally-run
 * moonlight-web-stream process, behind the same session-cookie auth gate as
 * every other route — see remote/moonlightWebStream.ts for how that process
 * is started/stopped. websocket: true forwards its own
 * WebSocket/WebRTC-signalling traffic too.
 *
 * moonlight-web-stream's own frontend generates absolute-path links (e.g.
 * `/api/authenticate`), so it needs to be told it's mounted under /stream
 * via its `web_server.url_path_prefix` config — otherwise those links point
 * at LumaArcade's own root and 404. @fastify/http-proxy's default behavior
 * is to *strip* the prefix before forwarding upstream (rewritePrefix
 * defaults to ""), which would then send moonlight-web-stream requests it
 * no longer recognizes now that it expects the full /stream/... path —
 * rewritePrefix is set to the same value as prefix here specifically to
 * disable that stripping and keep the two in sync. */
export async function registerMoonlightRoutes(app: FastifyInstance) {
  // Bound once at server startup, same as the main listen port — changing
  // moonlightWebStreamPort in Settings requires a LumaArcade restart to
  // take effect on the proxy target.
  const port = getSetting("moonlightWebStreamPort");

  await app.register(fastifyHttpProxy, {
    upstream: `http://127.0.0.1:${port}`,
    prefix: PROXY_PREFIX,
    rewritePrefix: PROXY_PREFIX,
    websocket: true,
    preHandler: requireAuth,
  });

  app.get(
    "/api/moonlight/status",
    { preHandler: requireAuth },
    async (): Promise<{ reachable: boolean }> => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}${PROXY_PREFIX}/`, {
          signal: AbortSignal.timeout(1500),
        });
        return { reachable: res.ok || res.status < 500 };
      } catch {
        return { reachable: false };
      }
    }
  );
}
