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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COOKIE_SECRET_SETTING_KEY = "cookieSecret";

export async function createServer(opts: { port: number; cookieSecret: string }) {
  const app = Fastify({ logger: true });

  await app.register(fastifyCookie, { secret: opts.cookieSecret });
  await app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "..", "..", "client", "dist"),
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

  await app.ready();

  // --- WebSocket upgrade handling, shared HTTP server ---
  const signallingWss = createSignallingServer((req) => authorizedFromCookieHeader(app, req));
  const inputWss = new WebSocketServer({ noServer: true });

  inputWss.on("connection", (ws) => {
    ws.on("message", (data) => {
      try {
        const event = JSON.parse(data.toString()) as InputEvent;
        void applyInputEvent(event);
      } catch (err) {
        app.log.warn({ err }, "bad input event");
      }
    });
  });

  app.server.on("upgrade", (request, socket, head) => {
    const url = request.url ?? "";
    if (url.startsWith("/signalling")) {
      signallingWss.handleUpgrade(request, socket, head, (ws) => {
        signallingWss.emit("connection", ws, request);
      });
    } else if (url.startsWith("/input")) {
      if (!authorizedFromCookieHeader(app, request)) {
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

export { COOKIE_SECRET_SETTING_KEY };
