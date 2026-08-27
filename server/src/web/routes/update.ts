import type { FastifyInstance } from "fastify";
import { checkForUpdate } from "../../remote/updateCheck.js";
import { applySelfUpdate } from "../../remote/selfUpdate.js";
import { requireAuth } from "../session.js";

export async function registerUpdateRoutes(app: FastifyInstance) {
  app.get("/api/update/check", { preHandler: requireAuth }, async () => {
    return checkForUpdate();
  });

  app.post("/api/update/apply", { preHandler: requireAuth }, async (_request, reply) => {
    const result = await applySelfUpdate();
    if (!result.ok) {
      reply.code(400).send(result);
      return;
    }
    return result;
  });
}
