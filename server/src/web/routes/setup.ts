import type { FastifyInstance } from "fastify";
import { runSetup } from "../../setup/apply.js";
import { requireAuth } from "../session.js";

export async function registerSetupRoutes(app: FastifyInstance) {
  app.post("/api/setup/run", { preHandler: requireAuth }, async () => runSetup());
}
