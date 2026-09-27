import type { FastifyInstance, FastifyRequest } from "fastify";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { Readable } from "node:stream";
import { checkStreamInit, filterAppList, isAppListRequest, rememberSocketAccess, streamClosed } from "../appAccess.js";
import { clearAttempts, isRateLimited, recordFailedAttempt } from "../auth.js";
import { clientIp } from "../requestOrigin.js";
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
    // Without this, @fastify/http-proxy strips the /stream prefix before
    // forwarding upstream (a request to /stream/ arrives at
    // moonlight-web-stream as bare /) - but moonlight-web-stream itself was
    // launched with --path-prefix /stream, so it expects to see that
    // prefix, not have it stripped, and 404s on the stripped path instead.
    // Confirmed directly: moonlight-web-stream returns 200 for /stream/ and
    // 404 for bare / on its own port.
    rewritePrefix: PROXY_PREFIX,
    websocket: true,
    // No gate of LumaArcade's own any more: moonlight-web-stream's sign-in
    // is the only login, and it guards its own API. Its login does get the
    // rate limit LumaArcade's old portal password had.
    preHandler: async (request, reply) => {
      if (isLoginRequest(request) && isRateLimited(clientIp(request))) {
        reply.code(429).send({ error: "Too many sign-in attempts. Wait a minute and try again." });
        return;
      }
      await rememberSocketAccess(request);
    },
    // Per-person app access (routes/admin.ts, appAccess.ts): the app list
    // is filtered on the way out, and a stream's Init message is checked.
    replyOptions: {
      rewriteRequestHeaders: (request, headers) =>
        isAppListRequest(request as unknown as FastifyRequest, PROXY_PREFIX)
          ? { ...headers, "accept-encoding": "identity" }
          : headers,
      onResponse: (request, reply, res) => {
        const req = request as unknown as FastifyRequest;
        if (isLoginRequest(req)) {
          if (reply.statusCode === 401 || reply.statusCode === 404) recordFailedAttempt(clientIp(req));
          else if (reply.statusCode < 300) clearAttempts(clientIp(req));
        }
        if (isAppListRequest(req, PROXY_PREFIX)) {
          void filterAppList(req, reply as never, res as unknown as { stream: Readable });
        } else {
          reply.send((res as unknown as { stream: Readable }).stream);
        }
      },
    },
    wsHooks: {
      onIncomingMessage: (_context, source, target, message) =>
        checkStreamInit(source as never, target as never, message.data, message.binary),
      onDisconnect: (_context, source) => streamClosed(source as never),
    },
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

function isLoginRequest(request: FastifyRequest): boolean {
  return request.method === "POST" && request.url.split("?")[0] === `${PROXY_PREFIX}/api/login`;
}
