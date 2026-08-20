import type { FastifyInstance } from "fastify";
import { launchGame } from "../../library/launch.js";
import { listDistinctConsoles, listGames, type GameRow } from "../../library/repo.js";
import { runLibraryScan } from "../../library/scan.js";
import { requireAuth } from "../session.js";

export async function registerLibraryRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { source?: GameRow["source"] } }>(
    "/api/games",
    { preHandler: requireAuth },
    async (request) => listGames(request.query.source)
  );

  app.get("/api/consoles", { preHandler: requireAuth }, async () => listDistinctConsoles());

  app.post("/api/library/scan", { preHandler: requireAuth }, async (_request, reply) => {
    try {
      await runLibraryScan();
      return { ok: true };
    } catch (err) {
      app.log.error({ err }, "library scan failed");
      reply.code(500).send({ ok: false, error: "scan failed" });
    }
  });

  app.post<{ Params: { id: string } }>(
    "/api/games/:id/launch",
    { preHandler: requireAuth },
    async (request, reply) => {
      const id = Number(request.params.id);
      const result = launchGame(id);
      if (!result.ok) {
        reply.code(400).send(result);
        return;
      }
      return result;
    }
  );
}
