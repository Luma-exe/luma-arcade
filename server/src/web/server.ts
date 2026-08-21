import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  clearAttempts,
  createSession,
  destroySession,
  isPasswordSet,
  isRateLimited,
  isSessionValid,
  recordFailedAttempt,
  setPassword,
  verifyPassword,
} from "./auth.js";
import { clearSessionCookie, getSessionId, requireAuth, setSessionCookie } from "./session.js";
import { createSignallingServer } from "../signalling/server.js";
import { applyInputEvent, type InputEvent } from "../input/injector.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerLibraryRoutes } from "./routes/library.js";
import { registerRomFolderRoutes } from "./routes/romFolders.js";
import { registerCustomAppRoutes } from "./routes/customApps.js";
import { registerStreamRoutes } from "./routes/stream.js";
import { registerWebrtcConfigRoutes } from "./routes/webrtcConfig.js";
import { registerEsdeRoutes } from "./routes/esde.js";
import { registerDependencyRoutes } from "./routes/dependencies.js";
import { registerUpdateRoutes } from "./routes/update.js";
import { registerRdpRoutes } from "./routes/rdp.js";
import { registerProducerRoutes } from "./routes/producer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COOKIE_SECRET_SETTING_KEY = "cookieSecret";

export async function createServer(opts: { port: number; cookieSecret: string }) {
  const app = Fastify({ logger: { level: process.env.LUMA_LOG_LEVEL || "info" } });

  await app.register(fastifyCookie, { secret: opts.cookieSecret });
  await app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "..", "..", "client", "dist"),
  });

  // Routes like /api/esde/launch are POSTed with no body at all (see
  // api.ts) — fine talking to Fastify directly, but a request proxied
  // through the Cloudflare Tunnel can pick up a Content-Type header along
  // the way even with an empty body, and Fastify's default content-type
  // parser hard-rejects anything outside application/json / text/plain
  // with a 415. The real JSON-bodied routes (settings, rom-folders, etc.)
  // still explicitly set Content-Type: application/json client-side and
  // are handled by Fastify's built-in parser first — this only catches
  // whatever's left over.
  app.addContentTypeParser("*", (_request, _payload, done) => {
    done(null, undefined);
  });

  app.get("/api/auth/status", async () => ({ passwordSet: isPasswordSet() }));

  app.post<{ Body: { password: string } }>("/api/auth/set-password", async (request, reply) => {
    if (isPasswordSet()) {
      reply.code(409).send({ error: "password already set" });
      return;
    }
    const { password } = request.body ?? {};
    if (!password || password.length < 8) {
      reply.code(400).send({ error: "password must be at least 8 characters" });
      return;
    }
    await setPassword(password);
    const session = createSession();
    setSessionCookie(reply, session.id, session.expiresAt);
    return { ok: true };
  });

  app.post<{ Body: { password: string } }>("/api/auth/login", async (request, reply) => {
    const ip = request.ip;
    if (isRateLimited(ip)) {
      reply.code(429).send({ error: "too many attempts, try again shortly" });
      return;
    }
    const { password } = request.body ?? {};
    const valid = password ? await verifyPassword(password) : false;
    if (!valid) {
      recordFailedAttempt(ip);
      reply.code(401).send({ error: "invalid password" });
      return;
    }
    clearAttempts(ip);
    const session = createSession();
    setSessionCookie(reply, session.id, session.expiresAt);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const sessionId = getSessionId(request);
    if (sessionId) destroySession(sessionId);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/api/me", { preHandler: requireAuth }, async () => ({ ok: true }));

  await registerSettingsRoutes(app);
  await registerLibraryRoutes(app);
  await registerRomFolderRoutes(app);
  await registerCustomAppRoutes(app);
  await registerStreamRoutes(app, { port: opts.port });
  await registerWebrtcConfigRoutes(app);
  await registerEsdeRoutes(app);
  await registerDependencyRoutes(app);
  await registerUpdateRoutes(app);
  await registerRdpRoutes(app);
  await registerProducerRoutes(app, { port: opts.port });

  await app.ready();

  // --- WebSocket upgrade handling, shared HTTP server ---
  const signallingWss = createSignallingServer((req) => authorizedForSignalling(app, req));
  const inputWss = new WebSocketServer({ noServer: true });

  inputWss.on("connection", (ws) => {
    app.log.debug("input socket connected");
    // Events must apply in the order they were sent and one at a time —
    // firing applyInputEvent() per message without awaiting it let a burst
    // of gamepad updates race concurrently against mousemove's read-modify-
    // write of the cursor position (getPosition, add delta, setPosition),
    // which could interleave and cancel movement out under load.
    let queue = Promise.resolve();
    ws.on("message", (data) => {
      let event: InputEvent;
      try {
        event = JSON.parse(data.toString()) as InputEvent;
      } catch (err) {
        app.log.warn({ err }, "bad input event");
        return;
      }
      app.log.debug({ event }, "input event received");
      queue = queue.then(() =>
        applyInputEvent(event).catch((err) => {
          app.log.warn({ err, event }, "input event failed to apply");
        })
      );
    });
    ws.on("close", (code) => app.log.debug({ code }, "input socket closed"));
  });

  app.server.on("upgrade", (request, socket, head) => {
    const url = request.url ?? "";
    if (url.startsWith("/signalling")) {
      signallingWss.handleUpgrade(request, socket, head, (ws) => {
        signallingWss.emit("connection", ws, request);
      });
    } else if (url.startsWith("/input")) {
      if (!authorizedFromCookieHeader(app, request)) {
        app.log.warn("input socket rejected: no valid session cookie");
        socket.destroy();
        return;
      }
      inputWss.handleUpgrade(request, socket, head, (ws) => {
        inputWss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  await app.listen({ port: opts.port, host: "0.0.0.0" });

  return app;
}

function authorizedFromCookieHeader(app: ReturnType<typeof Fastify>, req: { headers: { cookie?: string } }): boolean {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return false;
  const match = /luma_session=([^;]+)/.exec(cookieHeader);
  if (!match) return false;
  const unsigned = app.unsignCookie(decodeURIComponent(match[1]));
  if (!unsigned.valid || !unsigned.value) return false;
  return isSessionValid(unsigned.value);
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Signalling connections come from two different kinds of peer: browser
 * consumers (present a session cookie) and the GStreamer producer we spawn
 * ourselves (a plain WS client with no cookie). A query-string token turned
 * out not to work as the distinguishing signal — verified empirically that
 * webrtcsink's signaller strips the query string from `signaller::uri`
 * before connecting, so the token never arrives. The producer always
 * connects to `ws://127.0.0.1:<port>/signalling` (hardcoded in
 * routes/stream.ts), so loopback origin is used instead: exempt only
 * connections from 127.0.0.1/::1 itself. LAN/remote consumers always arrive
 * from a different source address and still need the session cookie. This
 * is an acceptable tradeoff for a single-user local app — anyone with
 * process-level access to loopback on this machine already has much
 * stronger access than the signalling relay could ever expose. */
function authorizedForSignalling(
  app: ReturnType<typeof Fastify>,
  req: { headers: { cookie?: string }; url?: string; socket?: { remoteAddress?: string } }
): boolean {
  const remoteAddress = req.socket?.remoteAddress;
  if (remoteAddress && LOOPBACK_ADDRESSES.has(remoteAddress)) return true;
  return authorizedFromCookieHeader(app, req);
}

export { COOKIE_SECRET_SETTING_KEY };
