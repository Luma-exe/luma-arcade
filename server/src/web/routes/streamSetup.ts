import type { FastifyInstance } from "fastify";
import { requireAuth } from "../session.js";
import { streamUser } from "../streamUser.js";
import { cleanSetupSettings, getStreamSetup, saveStreamSetup } from "../streamSetup.js";

/** The one-time stream setup (web/streamSetup.ts): the stream page asks
 * whether it's been done, and the setup page saves it. Run again from
 * Settings (redo: true), it replaces the saved one. */
export async function registerStreamSetupRoutes(app: FastifyInstance) {
  app.get("/api/me/stream-setup", { preHandler: requireAuth, logLevel: "warn" }, async (request, reply) => {
    const user = await streamUser(request);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    return getStreamSetup(user.id);
  });

  app.post<{ Body: { mode?: unknown; redo?: unknown; settings?: unknown; measure?: { mbps?: unknown; pingMs?: unknown; jitterMs?: unknown } } }>(
    "/api/me/stream-setup",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = await streamUser(request);
      if (!user) return reply.code(401).send({ error: "unauthorized" });
      const mode = request.body?.mode;
      if (mode !== "static" && mode !== "auto") return reply.code(400).send({ error: "mode must be static or auto" });
      const settings = cleanSetupSettings(mode, request.body?.settings);
      const redo = request.body?.redo === true;
      if (!saveStreamSetup(user.id, mode, settings, Date.now(), redo)) {
        return reply.code(409).send({ error: "Stream setup is already done", setup: getStreamSetup(user.id) });
      }
      const m = request.body?.measure ?? {};
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
      request.log.info(
        { player: user.name, mode, redo, settings, mbps: num(m.mbps), pingMs: num(m.pingMs), jitterMs: num(m.jitterMs) },
        "stream setup"
      );
      return getStreamSetup(user.id);
    }
  );
}
