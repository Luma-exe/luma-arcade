import type { FastifyInstance } from "fastify";
import { launchOrAttachEsde } from "../../library/esde.js";
import { requireAuth } from "../session.js";

export async function registerEsdeRoutes(app: FastifyInstance) {
  app.post("/api/esde/launch", { preHandler: requireAuth }, async (_request, reply) => {
    const result = await launchOrAttachEsde();
    if (!result.ok) {
      reply.code(400).send(result);
      return;
    }
    return result;
  });
}
