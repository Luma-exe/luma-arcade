import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { profilesInstalled, runProfiles as profiles } from "../profilesScript.js";
import { requireAuth } from "../session.js";
import { streamUser } from "../streamUser.js";

// Save snapshots: a player backs up their own saves ("before the boss") and
// restores one later. The work is done by the per-player saves script
// (host/profiles.ps1 -Action snapshot|list|restore), which knows where each
// player's saves are right now.

const SNAPSHOT_NAME = /^\d{8}-\d{6}$/;

// Each snapshot copies a player's saves, so a mashed button shouldn't pile
// them up. Least time between two successful runs of the same action by one
// player; a failed one doesn't count, so a mistake can be retried at once.
// (The saves script itself keeps only the newest few snapshots.) The list
// is reloaded after every snapshot and restore, so its gap is short.
const MIN_GAP_MS = { snapshot: 30_000, restore: 30_000, list: 1_000 };

type SaveAction = keyof typeof MIN_GAP_MS;
const lastCall = new Map<string, number>();

/** Seconds to wait before this player may repeat the action, or 0 if they may
 * go now. Exported for the test. */
export function throttleWait(userId: number | string, action: SaveAction, now = Date.now()): number {
  const last = lastCall.get(`${userId}:${action}`);
  if (last !== undefined && now - last < MIN_GAP_MS[action]) {
    return Math.ceil((MIN_GAP_MS[action] - (now - last)) / 1000);
  }
  return 0;
}

/** Remembers a successful run for throttleWait. Exported for the test. */
export function recordSaveAction(userId: number | string, action: SaveAction, now = Date.now()): void {
  lastCall.set(`${userId}:${action}`, now);
}

export function resetSavesThrottle(): void {
  lastCall.clear();
}

async function withPlayer(
  request: FastifyRequest,
  reply: FastifyReply,
  action: SaveAction,
  work: (player: string) => Promise<Record<string, unknown>>
): Promise<unknown> {
  const user = await streamUser(request);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  if (!profilesInstalled()) {
    return reply.code(503).send({ error: "Per-player saves aren't set up on this PC, so there's nothing to snapshot." });
  }
  const wait = throttleWait(user.id, action);
  if (wait > 0) {
    return reply.code(429).send({ error: `Easy there, try again in ${wait} second${wait === 1 ? "" : "s"}.` });
  }
  try {
    const result = await work(`${user.id}:${user.name}`);
    if (result.error) return reply.code(409).send(result);
    recordSaveAction(user.id, action);
    return result;
  } catch (err) {
    return reply.code(500).send({ error: `Couldn't reach the saves script: ${(err as Error).message}` });
  }
}

export async function registerSavesRoutes(app: FastifyInstance) {
  app.get("/api/saves", { preHandler: requireAuth }, (request, reply) =>
    withPlayer(request, reply, "list", (player) => profiles(["-Action", "list", "-Player", player]))
  );

  app.post<{ Body: { label?: string } }>("/api/saves/snapshot", { preHandler: requireAuth }, (request, reply) =>
    withPlayer(request, reply, "snapshot", async (player) => {
      const label = String(request.body?.label ?? "").replace(/[\r\n]/g, " ").trim().slice(0, 60);
      return profiles(["-Action", "snapshot", "-Player", player, ...(label ? ["-Label", label] : [])]);
    })
  );

  app.post<{ Body: { snapshot?: string } }>("/api/saves/restore", { preHandler: requireAuth }, (request, reply) =>
    withPlayer(request, reply, "restore", async (player) => {
      const name = String(request.body?.snapshot ?? "");
      if (!SNAPSHOT_NAME.test(name)) return { error: "No such snapshot" };
      return profiles(["-Action", "restore", "-Player", player, "-Snapshot", name]);
    })
  );
}
