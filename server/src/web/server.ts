import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { requireAuth } from "./session.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerUpdateRoutes } from "./routes/update.js";
import { registerMoonlightRoutes } from "./routes/moonlight.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSpeedtestRoutes } from "./routes/speedtest.js";
import { registerHomeRoutes } from "./routes/home.js";
import { registerInputRoutes } from "./routes/input.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { MOONLIGHT_PATH_PREFIX } from "../remote/moonlightWebStream.js";
import { TRUSTED_PROXIES } from "./requestOrigin.js";

const COOKIE_SECRET_SETTING_KEY = "cookieSecret";

export async function createServer(opts: { port: number; cookieSecret: string }) {
  const app = Fastify({
    logger: { level: process.env.LUMA_LOG_LEVEL || "info" },
    // cloudflared (and the Vite dev proxy) connect from loopback; trusting
    // them makes request.ip/request.protocol reflect the real visitor.
    trustProxy: TRUSTED_PROXIES,
    // Pages under /stream call LumaArcade at /stream/luma-api/... instead of
    // /api/...: moonlight-web-stream scopes its session cookie to /stream,
    // so only there does the browser send it, and only with it can
    // LumaArcade tell who is asking (web/streamUser.ts).
    rewriteUrl: (req) =>
      req.url?.startsWith(`${MOONLIGHT_PATH_PREFIX}/luma-api/`)
        ? `/api/${req.url.slice(MOONLIGHT_PATH_PREFIX.length + "/luma-api/".length)}`
        : req.url ?? "/",
  });

  await app.register(fastifyCookie, { secret: opts.cookieSecret });

  // The arcade is moonlight-web-stream under /stream, and its sign-in is the
  // only login (LumaArcade's old portal password page is gone). The tray's
  // Settings item links to /?view=settings, which carries over.
  app.get("/", async (request, reply) => {
    const query = request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : "";
    return reply.redirect(`${MOONLIGHT_PATH_PREFIX}/${query}`);
  });
  app.get("/api/me", { preHandler: requireAuth }, async () => ({ ok: true }));

  await registerSettingsRoutes(app);
  await registerUpdateRoutes(app);
  await registerMoonlightRoutes(app);
  await registerHealthRoutes(app);
  await registerSpeedtestRoutes(app);
  await registerHomeRoutes(app);
  await registerInputRoutes(app);
  await registerAdminRoutes(app);

  await app.listen({ port: opts.port, host: "0.0.0.0" });

  return app;
}

export { COOKIE_SECRET_SETTING_KEY };
