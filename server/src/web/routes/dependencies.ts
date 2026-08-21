import type { FastifyInstance } from "fastify";
import { checkDependencies, installDependency } from "../../config/dependencies.js";
import { requireAuth } from "../session.js";

export async function registerDependencyRoutes(app: FastifyInstance) {
  app.get("/api/dependencies", { preHandler: requireAuth }, async () => {
    return { dependencies: await checkDependencies() };
  });

  app.post<{ Body: { wingetId: string } }>(
    "/api/dependencies/install",
    { preHandler: requireAuth },
    async (request) => {
      installDependency(request.body.wingetId);
      return { ok: true, started: true };
    }
  );
}
