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

      // `port` ends up interpolated into a shell command at startup
      // (main.ts's `exec("start http://localhost:" + port)`) and
      // `moonlightWebStreamPort` ends up in a proxied URL — reject anything
      // that isn't actually a valid TCP port before it can reach either.
      for (const key of ["port", "moonlightWebStreamPort"] as const) {
        if (key in body) {
          const value = body[key];
          if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
            reply.code(400).send({ error: `${key} must be an integer between 1 and 65535.` });
            return;
          }
        }
      }

      // moonlightWebStreamPath is spawned as a child process the moment
      // this save completes (syncMoonlightWithSettings runs right below,
      // and moonlightAutoStart can already be true) — a session cookie
      // alone shouldn't be enough to make this server launch an arbitrary
      // local executable. Requiring it to already exist on disk is a weak
      // check (it doesn't stop someone pointing this at, say, an existing
      // powershell.exe), but it does stop the field from being a blind
      // "run whatever string I send" primitive, and it's the same class of
      // check already applied to devTreePath below.
      if (typeof body.moonlightWebStreamPath === "string" && body.moonlightWebStreamPath !== "") {
        const resolved = path.resolve(body.moonlightWebStreamPath);
        if (!existsSync(resolved)) {
          reply.code(400).send({ error: `${resolved} doesn't exist.` });
          return;
        }
        body.moonlightWebStreamPath = resolved;
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
