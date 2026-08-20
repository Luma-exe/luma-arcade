import type { FastifyInstance } from "fastify";
import { addRomFolder, listRomFolders, removeRomFolder } from "../../library/romScanner.js";
import { requireAuth } from "../session.js";

export async function registerRomFolderRoutes(app: FastifyInstance) {
  app.get("/api/rom-folders", { preHandler: requireAuth }, async () => listRomFolders());

  app.post<{
    Body: { console: string; folderPath: string; emulatorExePath: string; launchArgsTemplate: string };
  }>("/api/rom-folders", { preHandler: requireAuth }, async (request) => {
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
