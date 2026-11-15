import type { FastifyInstance } from "fastify";
import { checkForUpdate } from "../../remote/updateCheck.js";
import { applySelfUpdate, canSelfUpdate } from "../../remote/selfUpdate.js";
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
    // A plain install has no source tree to build from: say so instead of failing halfway.
    const can = canSelfUpdate();
    if (!can.ok) {
      reply.code(409).send({
        ok: false,
        log: [],
        error: `This install can't update itself. ${can.reason} Download the new version from the releases page instead.`,
      });
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
