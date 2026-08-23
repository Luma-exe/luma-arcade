import { existsSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { disableAutoStart, enableAutoStart } from "../../autostart/index.js";
import { getAllSettings, setSettings, type AppSettings } from "../../config/settings.js";
import { syncMoonlightWithSettings } from "../../remote/moonlightWebStream.js";
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

      // devTreePath ends up as the cwd for `git pull` / `npm install` /
      // `npm run build` in applySelfUpdate — reject anything that isn't
      // actually a git checkout at set-time, rather than only finding out
      // when someone clicks "Apply update". This narrows, not eliminates,
      // the risk (a real re-auth check on the apply step itself is the
      // actual gate — see routes/update.ts), but there's no reason to let
      // this field hold a value that could never be a legitimate build.
      if (typeof body.devTreePath === "string" && body.devTreePath !== "") {
        const resolved = path.resolve(body.devTreePath);
        if (!existsSync(path.join(resolved, ".git"))) {
          reply.code(400).send({ error: `${resolved} doesn't look like a git checkout (no .git folder).` });
          return;
        }
        body.devTreePath = resolved;
      }

      setSettings(body);
      syncMoonlightWithSettings();
      return getAllSettings();
    }
  );
}
