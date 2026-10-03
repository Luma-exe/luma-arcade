import Fastify from "fastify";
import { requireAuth } from "./session.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerUpdateRoutes } from "./routes/update.js";
import { registerMoonlightRoutes } from "./routes/moonlight.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSpeedtestRoutes } from "./routes/speedtest.js";
import { registerHomeRoutes } from "./routes/home.js";
import { registerInputRoutes } from "./routes/input.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerHandoverRoutes } from "./routes/handover.js";
import { registerProfileRoutes } from "./routes/profiles.js";
import { registerCoopRoutes } from "./routes/coop.js";
import { registerSavesRoutes } from "./routes/saves.js";
import { registerGuestLinkRoutes } from "./routes/guestLinks.js";
import { registerPollRoutes } from "./routes/poll.js";
import { registerGameRoutes } from "./routes/games.js";
import { registerWelcomeRoutes } from "./routes/welcome.js";
import { registerStreamSetupRoutes } from "./routes/streamSetup.js";
import { MOONLIGHT_PATH_PREFIX } from "../remote/moonlightWebStream.js";
import { TRUSTED_PROXIES, httpsUpgradeUrl } from "./requestOrigin.js";
import { registerHttpsRoutes, startHttps } from "./https.js";
import { problemLogHook } from "./diagnostics.js";

/** serverDir: the server folder (luma-arcade.db, https.json). */
export async function createServer(opts: { port: number; serverDir: string }) {
  const app = Fastify({
    // Warnings and errors are also kept for Host health's "Copy diagnostics".
    logger: { level: process.env.LUMA_LOG_LEVEL || "info", hooks: { logMethod: problemLogHook } },
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

  // From the internet it's https only (requestOrigin.ts: Safari on http://
  // couldn't stay signed in). 308 keeps a POST a POST.
  app.addHook("onRequest", async (request, reply) => {
    const to = httpsUpgradeUrl(request);
    if (to) return reply.redirect(to, request.method === "GET" || request.method === "HEAD" ? 301 : 308);
  });

  // The arcade is moonlight-web-stream under /stream, and its sign-in is the
  // only login. "/" is the welcome page (routes/welcome.ts); the tray's
  // Settings item links to /?view=settings, which still goes to the arcade.
  app.get("/api/me", { preHandler: requireAuth }, async () => ({ ok: true }));

  await registerSettingsRoutes(app);
  await registerUpdateRoutes(app);
  await registerMoonlightRoutes(app);
  await registerHealthRoutes(app);
  await registerSpeedtestRoutes(app);
  await registerHomeRoutes(app);
  await registerInputRoutes(app);
  await registerAdminRoutes(app);
  await registerHandoverRoutes(app);
  await registerProfileRoutes(app);
  await registerCoopRoutes(app);
  await registerSavesRoutes(app);
  await registerGuestLinkRoutes(app);
  await registerPollRoutes(app);
  await registerGameRoutes(app);
  await registerWelcomeRoutes(app);
  await registerStreamSetupRoutes(app);
  await registerHttpsRoutes(app, opts.serverDir);

  await app.listen({ port: opts.port, host: "0.0.0.0" });
  const httpsPort = await startHttps(app, opts.serverDir).catch((err) => {
    // The site still works over plain HTTP.
    app.log.error({ err }, "couldn't start HTTPS for the home network");
    return null;
  });

  return { app, httpsPort };
}
