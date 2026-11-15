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
import { notify } from "../notify.js";
import { GUEST_SESSION_ENDED, checkGuestSession } from "../guestSessions.js";
import { sturdySetCookieHeader } from "../sessionCookie.js";
import { proxyPath } from "../proxyPath.js";

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
    // ~120 proxied files per page would each log twice at info; warnings and
    // errors (and the stream started/ended lines, via app.log) still show.
    logLevel: "warn",
    // No gate of LumaArcade's own any more: moonlight-web-stream's sign-in
    // is the only login, and it guards its own API. Its login does get the
    // rate limit LumaArcade's old portal password had.
    preHandler: async (request, reply) => {
      // Every gate below reads the normalized path, because that is what
      // moonlight-web-stream acts on (proxyPath.ts). An API path that only
      // reaches the same place through escapes or dot segments isn't a
      // request a browser makes, so it is refused rather than interpreted.
      const normalized = proxyPath(request);
      if (normalized === null || (normalized !== rawPath(request) && /^\/stream\/(luma-)?api\//i.test(normalized))) {
        reply.code(400).send({ error: "Bad request." });
        return;
      }
      if (isLoginRequest(request)) {
        const ip = clientIp(request);
        if (isRateLimited(ip)) {
          reply.code(429).send({ error: "Too many sign-in attempts. Wait a minute and try again." });
          return;
        }
        loginIps.set(request, ip);
      }
      // Its API (not its files): a guest's session that should be over ends
      // (guestSessions.ts); moonlight-web-stream then shows the sign-in.
      if (normalized.toLowerCase().startsWith(`${PROXY_PREFIX}/api/`) && !isLoginRequest(request)) {
        if ((await checkGuestSession(request.headers.cookie)) === "ended") {
          reply.code(401).send({ error: GUEST_SESSION_ENDED });
          return;
        }
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
        // Its sign-in cookie, so it sticks on every browser (sessionCookie.ts).
        if (headers["set-cookie"]) headers = { ...headers, "set-cookie": sturdySetCookieHeader(headers["set-cookie"]) };
        const path = (request ? proxyPath(request as unknown as FastifyRequest) : null)?.toLowerCase() ?? "";
        if (request?.method !== "GET" || path.startsWith(`${PROXY_PREFIX}/api/`) || !headers.etag) return headers;
        const longLived = /\/(libopus|libopenh264|resources)\//.test(path);
        const { pragma: _pragma, ...rest } = headers;
        // "private": Cloudflare replaces a bare "no-cache" with its own 4-hour
        // browser cache time, so updates took hours to reach people; it
        // leaves private answers alone.
        return { ...rest, "cache-control": longLived ? "public, max-age=604800" : "private, no-cache" };
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
          // Its login answers 404 for a name that doesn't exist and 401 for a
          // wrong password, which tells anyone which names are real. Both
          // become the same 401 (its page treats them alike, static/api.js).
          if (reply.statusCode === 404) {
            (res as unknown as { stream: Readable }).stream.destroy();
            for (const header of ["content-length", "content-type", "content-encoding", "transfer-encoding", "set-cookie", "etag"]) {
              reply.removeHeader(header);
            }
            reply.code(401).send({ error: "Wrong username or password." });
            return;
          }
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
      onIncomingMessage: (_context, source, target, message) => {
        const before = streamOwnerName(source as never);
        checkStreamInit(source as never, target as never, message.data, message.binary);
        const who = streamOwnerName(source as never);
        if (who && !before) {
          app.log.info({ player: who }, "stream started");
          // (Quality switches and reconnects start new streams: once per half hour.)
          void notify(`🎮 ${who} started playing`, `start:${who}`, 30 * 60_000);
        }
      },
      onDisconnect: (_context, source) => {
        const who = streamOwnerName(source as never);
        if (who) app.log.info({ player: who }, "stream ended");
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
  return request.method === "POST" && proxyPath(request)?.toLowerCase() === `${PROXY_PREFIX}/api/host/cancel`;
}

function isLoginRequest(request: FastifyRequest): boolean {
  return request.method === "POST" && proxyPath(request)?.toLowerCase() === `${PROXY_PREFIX}/api/login`;
}

/** The URL's path as sent (query stripped), to tell if normalizing changed it. */
function rawPath(request: FastifyRequest): string {
  return (request.url ?? "").split("?")[0];
}
