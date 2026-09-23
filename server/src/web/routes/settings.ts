import type { FastifyInstance } from "fastify";
import { disableAutoStart, enableAutoStart } from "../../autostart/index.js";
import { getAllSettings, setSettings, type AppSettings } from "../../config/settings.js";
import { syncMoonlightWithSettings } from "../../remote/moonlightWebStream.js";
import { isLocalRequest } from "../requestOrigin.js";
import { requireAuth } from "../session.js";

/** Settings that make the host execute a file or rebind the server. Anyone
 * with the password could otherwise turn a leaked password into running
 * arbitrary programs on this PC, so these only change from the home network. */
const LOCAL_ONLY_KEYS: (keyof AppSettings)[] = [
  "moonlightWebStreamPath",
  "moonlightWebStreamPort",
  "devTreePath",
  "port",
];

export async function registerSettingsRoutes(app: FastifyInstance) {
  app.get("/api/settings", { preHandler: requireAuth }, async () => getAllSettings());

  app.put<{ Body: Partial<AppSettings> }>(
    "/api/settings",
    { preHandler: requireAuth },
    async (request, reply) => {
      const current = getAllSettings();
      // Only known settings. The settings table also holds internal values
      // (e.g. cookieSecret) that must never be writable from this route.
      const body = Object.fromEntries(
        Object.entries(request.body ?? {}).filter(([key]) => key in current)
      ) as Partial<AppSettings>;

      const blocked = LOCAL_ONLY_KEYS.filter(
        (key) => key in body && body[key] !== current[key]
      );
      if (blocked.length > 0 && !isLocalRequest(request)) {
        reply.code(403).send({
          error: `${blocked.join(", ")} can only be changed from the home network`,
        });
        return;
      }

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
      syncMoonlightWithSettings();
      return getAllSettings();
    }
  );
}
