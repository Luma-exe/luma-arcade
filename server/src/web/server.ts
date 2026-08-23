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
  pruneExpiredSessions,
  pruneStaleAttempts,
  recordFailedAttempt,
  setPassword,
  verifyPassword,
} from "./auth.js";
import { clearSessionCookie, getSessionId, requireAuth, setSessionCookie } from "./session.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerUpdateRoutes } from "./routes/update.js";
import { registerMoonlightRoutes } from "./routes/moonlight.js";
import { registerSetupRoutes } from "./routes/setup.js";

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
    const { password } = request.body ?? {};
    if (!password || password.length < 8) {
      reply.code(400).send({ error: "password must be at least 8 characters" });
      return;
    }
    // setPassword itself is the source of truth on whether this is the
    // first-ever password (a plain INSERT that fails on conflict) rather
    // than this route pre-checking isPasswordSet() and trusting that
    // nothing else set it in between — two concurrent first-run requests
    // could otherwise both pass the pre-check and race to overwrite each
    // other's password.
    const wasSet = await setPassword(password);
    if (!wasSet) {
      reply.code(409).send({ error: "password already set" });
      return;
    }
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
  await registerSetupRoutes(app);
  await registerMoonlightRoutes(app);

  await app.listen({ port: opts.port, host: "0.0.0.0" });

  // Neither the rate-limiter Map nor expired session rows are ever cleaned
  // up on their own (see auth.ts) — sweep both periodically instead of
  // letting them grow for the life of the process.
  const cleanupInterval = setInterval(
    () => {
      pruneStaleAttempts();
      pruneExpiredSessions();
    },
    10 * 60 * 1000
  );
  cleanupInterval.unref();

  return app;
}

export { COOKIE_SECRET_SETTING_KEY };
