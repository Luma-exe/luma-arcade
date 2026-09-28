import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { profilesInstalled, runProfiles as profiles } from "../profilesScript.js";
import { requireAuth } from "../session.js";
import { streamUser } from "../streamUser.js";

// Save snapshots: a player backs up their own saves ("before the boss") and
// restores one later. The work is done by the per-player saves script
// (host/profiles.ps1 -Action snapshot|list|restore), which knows where each
// player's saves are right now.

const SNAPSHOT_NAME = /^\d{8}-\d{6}$/;

async function withPlayer(
  request: FastifyRequest,
  reply: FastifyReply,
  work: (player: string) => Promise<Record<string, unknown>>
): Promise<unknown> {
  const user = await streamUser(request);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  if (!profilesInstalled()) {
    return reply.code(503).send({ error: "Per-player saves aren't set up on this PC, so there's nothing to snapshot." });
  }
  try {
    const result = await work(`${user.id}:${user.name}`);
    if (result.error) return reply.code(409).send(result);
    return result;
  } catch (err) {
    return reply.code(500).send({ error: `Couldn't reach the saves script: ${(err as Error).message}` });
  }
}

export async function registerSavesRoutes(app: FastifyInstance) {
  app.get("/api/saves", { preHandler: requireAuth }, (request, reply) =>
    withPlayer(request, reply, (player) => profiles(["-Action", "list", "-Player", player]))
  );

  app.post<{ Body: { label?: string } }>("/api/saves/snapshot", { preHandler: requireAuth }, (request, reply) =>
    withPlayer(request, reply, (player) => {
      const label = String(request.body?.label ?? "").replace(/[\r\n]/g, " ").trim().slice(0, 60);
      return profiles(["-Action", "snapshot", "-Player", player, ...(label ? ["-Label", label] : [])]);
    })
  );

  app.post<{ Body: { snapshot?: string } }>("/api/saves/restore", { preHandler: requireAuth }, (request, reply) =>
    withPlayer(request, reply, async (player) => {
      const name = String(request.body?.snapshot ?? "");
      if (!SNAPSHOT_NAME.test(name)) return { error: "No such snapshot" };
      return profiles(["-Action", "restore", "-Player", player, "-Snapshot", name]);
    })
  );
}
