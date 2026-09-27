import type { FastifyInstance } from "fastify";
import { checkForUpdate } from "../../remote/updateCheck.js";
import { applySelfUpdate } from "../../remote/selfUpdate.js";
import { requireAdmin } from "../streamUser.js";

export async function registerUpdateRoutes(app: FastifyInstance) {
  app.get("/api/update/check", { preHandler: requireAdmin }, async () => {
    return checkForUpdate();
  });

  app.post("/api/update/apply", { preHandler: requireAdmin }, async (_request, reply) => {
    const result = await applySelfUpdate();
    if (!result.ok) {
      reply.code(400).send(result);
      return;
    }
    return result;
  });
}
