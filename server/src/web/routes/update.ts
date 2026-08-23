import type { FastifyInstance } from "fastify";
import { checkForUpdate } from "../../remote/updateCheck.js";
import { applySelfUpdate } from "../../remote/selfUpdate.js";
import { verifyPassword } from "../auth.js";
import { requireAuth } from "../session.js";

export async function registerUpdateRoutes(app: FastifyInstance) {
  app.get("/api/update/check", { preHandler: requireAuth }, async () => {
    return checkForUpdate();
  });

  // Unlike every other settings-style action, this one runs `git pull` +
  // `npm install` + `npm run build` (arbitrary package.json scripts) in
  // whatever directory devTreePath points at — a much higher-privilege
  // action than a session cookie alone should be able to trigger (a
  // stolen/leaked cookie shouldn't be enough to get code execution).
  // Requiring the password again here, the same way the browser's own
  // "confirm your password" prompts work for sensitive actions, closes
  // that gap without needing a whole separate permission system.
  app.post<{ Body: { password?: string } }>(
    "/api/update/apply",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { password } = request.body ?? {};
      if (!password || !(await verifyPassword(password))) {
        reply.code(401).send({ error: "password required to apply an update" });
        return;
      }
      const result = await applySelfUpdate();
      if (!result.ok) {
        reply.code(400).send(result);
        return;
      }
      return result;
    }
  );
}
