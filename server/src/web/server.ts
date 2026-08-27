import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearAttempts,
  createSession,
  destroySession,
  isPasswordSet,
  isRateLimited,
  recordFailedAttempt,
  setPassword,
  verifyPassword,
} from "./auth.js";
import { clearSessionCookie, getSessionId, requireAuth, setSessionCookie } from "./session.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerUpdateRoutes } from "./routes/update.js";
import { registerMoonlightRoutes } from "./routes/moonlight.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COOKIE_SECRET_SETTING_KEY = "cookieSecret";

export async function createServer(opts: { port: number; cookieSecret: string }) {
  const app = Fastify({ logger: { level: process.env.LUMA_LOG_LEVEL || "info" } });

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
  await registerUpdateRoutes(app);
  await registerMoonlightRoutes(app);

  await app.listen({ port: opts.port, host: "0.0.0.0" });

  return app;
}

export { COOKIE_SECRET_SETTING_KEY };
