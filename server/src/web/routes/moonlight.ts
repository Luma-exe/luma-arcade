import type { FastifyInstance, FastifyRequest } from "fastify";
import fastifyHttpProxy from "@fastify/http-proxy";
import type { Readable } from "node:stream";
import { checkStreamInit, filterAppList, isAppListRequest, rememberSocketAccess, streamClosed, streamOwnerName, streamSocketOpened } from "../appAccess.js";
import { clearAttempts, isRateLimited, recordFailedAttempt } from "../auth.js";
import { clientIp } from "../requestOrigin.js";
import { getSetting } from "../../config/settings.js";
import { requireAuth } from "../session.js";
import { mayStopSession } from "../sessions.js";
import { streamUser } from "../streamUser.js";
import { moonlightProcess, MOONLIGHT_PATH_PREFIX } from "../../remote/moonlightWebStream.js";

const PROXY_PREFIX = MOONLIGHT_PATH_PREFIX;

// A login's client IP, taken in preHandler: by the time moonlight-web-stream's
// reply reaches onResponse the request's socket is gone (request.socket is
// null), and reading it there crashed the whole server on every sign-in.
const loginIps = new WeakMap<object, string>();

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
      if (isLoginRequest(request)) {
        const ip = clientIp(request);
        if (isRateLimited(ip)) {
          reply.code(429).send({ error: "Too many sign-in attempts. Wait a minute and try again." });
          return;
        }
        loginIps.set(request, ip);
      }
      if (isStopSessionRequest(request)) {
        const user = await streamUser(request);
        if (user && !mayStopSession(user)) {
          reply.code(403).send({ error: "This game belongs to someone else. Ask them to hand it over instead." });
          return;
        }
      }
      await rememberSocketAccess(request);
    },
    // Per-person app access (routes/admin.ts, appAccess.ts): the app list
    // is filtered on the way out, and a stream's Init message is checked.
    replyOptions: {
      // moonlight-web-stream sends every file "no-store", so browsers fetch
      // all ~120 of the site's scripts again on every visit, through the
      // tunnel. Its files carry an ETag and it answers If-None-Match with
      // 304, so the site's own files are kept but checked each time
      // (updates still show at once), and the codec libraries and images,
      // which never change, are kept for a week. API answers are untouched.
      rewriteHeaders: (headers, request) => {
        const path = (request?.url ?? "").split("?")[0];
        if (request?.method !== "GET" || path.startsWith(`${PROXY_PREFIX}/api/`) || !headers.etag) return headers;
        const longLived = /\/(libopus|libopenh264|resources)\//.test(path);
        const { pragma: _pragma, ...rest } = headers;
        return { ...rest, "cache-control": longLived ? "public, max-age=604800" : "no-cache" };
      },
      rewriteRequestHeaders: (request, headers) =>
        isAppListRequest(request as unknown as FastifyRequest, PROXY_PREFIX)
          ? { ...headers, "accept-encoding": "identity" }
          : headers,
      onResponse: (request, reply, res) => {
        const req = request as unknown as FastifyRequest;
        const loginIp = loginIps.get(req);
        if (loginIp) {
          if (reply.statusCode === 401 || reply.statusCode === 404) recordFailedAttempt(loginIp);
          else if (reply.statusCode < 300) clearAttempts(loginIp);
        }
        if (isAppListRequest(req, PROXY_PREFIX)) {
          void filterAppList(req, reply as never, res as unknown as { stream: Readable });
        } else {
          reply.send((res as unknown as { stream: Readable }).stream);
        }
      },
    },
    wsHooks: {
      onConnect: (_context, source) => streamSocketOpened(source as never),
      onIncomingMessage: (context, source, target, message) => {
        const before = streamOwnerName(source as never);
        checkStreamInit(source as never, target as never, message.data, message.binary);
        const who = streamOwnerName(source as never);
        if (who && !before) context.log.info({ player: who }, "stream started");
      },
      onDisconnect: (context, source) => {
        const who = streamOwnerName(source as never);
        if (who) context.log.info({ player: who }, "stream ended");
        streamClosed(source as never);
      },
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

function isStopSessionRequest(request: FastifyRequest): boolean {
  return request.method === "POST" && request.url.split("?")[0] === `${PROXY_PREFIX}/api/host/cancel`;
}

function isLoginRequest(request: FastifyRequest): boolean {
  return request.method === "POST" && request.url.split("?")[0] === `${PROXY_PREFIX}/api/login`;
}
