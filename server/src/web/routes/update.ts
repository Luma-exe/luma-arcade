import type { FastifyInstance } from "fastify";
import { checkForUpdate } from "../../remote/updateCheck.js";
import { applySelfUpdate } from "../../remote/selfUpdate.js";
import { isLocalRequest } from "../requestOrigin.js";
import { requireAdmin } from "../streamUser.js";

export async function registerUpdateRoutes(app: FastifyInstance) {
  app.get("/api/update/check", { preHandler: requireAdmin }, async () => {
    return checkForUpdate();
  });

  app.post("/api/update/apply", { preHandler: requireAdmin }, async (request, reply) => {
    // Pulls and builds code on this PC, so only from the home network.
    if (!isLocalRequest(request)) {
      reply.code(403).send({ error: "Updating only works from the home network" });
      return;
    }
    const result = await applySelfUpdate();
    if (!result.ok) {
      reply.code(400).send(result);
      return;
    }
    return result;
  });
}
