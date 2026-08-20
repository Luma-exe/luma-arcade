import type { FastifyInstance } from "fastify";
import { addRomFolder, listRomFolders, removeRomFolder } from "../../library/romScanner.js";
import { requireAuth } from "../session.js";

export async function registerRomFolderRoutes(app: FastifyInstance) {
  app.get("/api/rom-folders", { preHandler: requireAuth }, async () => listRomFolders());

  app.post<{
    Body: { console: string; folderPath: string; emulatorExePath: string; launchArgsTemplate: string };
  }>("/api/rom-folders", { preHandler: requireAuth }, async (request, reply) => {
    // Console id resolves to theme asset paths (systems/backgrounds/<id>.jpg
    // etc.) client-side, so it must be a safe path segment — the client
    // sends one of a known set via a <select>, this is defense in depth.
    if (!/^[a-z0-9_-]+$/.test(request.body.console ?? "")) {
      reply.code(400).send({ error: "invalid console id" });
      return;
    }
    addRomFolder(request.body);
    return listRomFolders();
  });

  app.delete<{ Params: { id: string } }>(
    "/api/rom-folders/:id",
    { preHandler: requireAuth },
    async (request) => {
      removeRomFolder(Number(request.params.id));
      return listRomFolders();
    }
  );
}
