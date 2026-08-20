import type { FastifyInstance } from "fastify";
import { disableAutoStart, enableAutoStart } from "../../autostart/index.js";
import { getAllSettings, setSettings, type AppSettings } from "../../config/settings.js";
import { syncCloudflaredWithSettings } from "../../remote/cloudflared.js";
import { syncCoturnWithSettings } from "../../remote/coturn.js";
import { requireAuth } from "../session.js";

export async function registerSettingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", { preHandler: requireAuth }, async () => getAllSettings());

  app.put<{ Body: Partial<AppSettings> }>(
    "/api/settings",
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = request.body ?? {};

      if (typeof body.autoStart === "boolean") {
        try {
          if (body.autoStart) await enableAutoStart();
          else await disableAutoStart();
        } catch (err) {
          reply.code(400).send({ error: (err as Error).message });
          return;
        }
      }

      setSettings(body);
      syncCloudflaredWithSettings();
      syncCoturnWithSettings();
      return getAllSettings();
    }
  );
}
