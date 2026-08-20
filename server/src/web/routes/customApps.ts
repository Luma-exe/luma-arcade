import type { FastifyInstance } from "fastify";
import { addCustomApp, listCustomApps, removeCustomApp } from "../../library/customApps.js";
import { requireAuth } from "../session.js";

export async function registerCustomAppRoutes(app: FastifyInstance) {
  app.get("/api/custom-apps", { preHandler: requireAuth }, async () => listCustomApps());

  app.post<{ Body: { displayName: string; exePath: string; iconPath?: string } }>(
    "/api/custom-apps",
    { preHandler: requireAuth },
    async (request) => {
      addCustomApp(request.body);
      return listCustomApps();
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/api/custom-apps/:id",
    { preHandler: requireAuth },
    async (request) => {
      removeCustomApp(Number(request.params.id));
      return listCustomApps();
    }
  );
}
