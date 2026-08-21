import type { FastifyInstance } from "fastify";
import { isRdpConnected } from "../../remote/rdpWatch.js";
import { requireAuth } from "../session.js";

export async function registerRdpRoutes(app: FastifyInstance) {
  app.get("/api/rdp-status", { preHandler: requireAuth }, async () => {
    return { connected: isRdpConnected() };
  });
}
