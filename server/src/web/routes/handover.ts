import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { notify } from "../notify.js";
import { requireAuth } from "../session.js";
import { streamUser, type StreamUser } from "../streamUser.js";
import { toStream } from "./coop.js";
import { prepareSaves } from "../savesReady.js";
import {
  answerOffer,
  answerRequest,
  cancelRequest,
  checkQueue,
  getRequest,
  inbox,
  joinQueue,
  leaveQueue,
  manage,
  people,
  requestHandover,
  type PersonAction,
  type RequestKind,
} from "../sessions.js";

const KINDS: RequestKind[] = ["handover", "player2", "spectate"];
const ACTIONS: PersonAction[] = ["player2", "spectator", "handover", "kick"];

// Asking whoever is streaming to hand the PC over (sessions.ts): the asker's
// stream page creates a request and polls it; the streamer's stream page
// polls its inbox and answers. Also waiting in line for the PC, and the
// streamer's page reporting how long they've been away from their controls.

async function withUser(
  request: FastifyRequest,
  reply: FastifyReply,
  run: (user: StreamUser) => unknown
): Promise<unknown> {
  const user = await streamUser(request);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  const result = run(user);
  if (result && typeof result === "object" && "error" in result) return reply.code(409).send(result);
  return result;
}

export async function registerHandoverRoutes(app: FastifyInstance) {
  /** kind: take the PC (default), join as player 2, or watch. */
  app.post<{ Body: { kind?: string } }>("/api/sessions/handover", { preHandler: requireAuth }, (request, reply) =>
    withUser(request, reply, (user) => {
      const kind = KINDS.find((k) => k === request.body?.kind) ?? "handover";
      const result = requestHandover(user, kind);
      if (!("error" in result)) {
        const what = kind === "player2" ? "to join the game" : kind === "spectate" ? "to watch" : "for the PC";
        void notify(`🙋 ${user.name} asked ${what}`, `ask:${user.id}`, 5 * 60_000);
      }
      return result;
    })
  );

  app.get<{ Params: { id: string } }>("/api/sessions/handover/:id", { preHandler: requireAuth }, (request, reply) =>
    withUser(request, reply, (user) => getRequest(request.params.id, user) ?? { error: "No such request." })
  );

  app.delete<{ Params: { id: string } }>("/api/sessions/handover/:id", { preHandler: requireAuth }, (request, reply) =>
    withUser(request, reply, (user) => {
      cancelRequest(request.params.id, user);
      return { ok: true };
    })
  );

  app.get("/api/sessions/handover-inbox", { preHandler: requireAuth, logLevel: "warn" }, (request, reply) =>
    withUser(request, reply, (user) => inbox(user))
  );

  /** grant: give something other than what they asked for; stream: the
   * player's, for a guest to join with. */
  app.post<{ Params: { id: string }; Body: { accept?: boolean; grant?: string; stream?: unknown } }>(
    "/api/sessions/handover/:id/answer",
    { preHandler: requireAuth },
    (request, reply) =>
      withUser(request, reply, (user) => {
        const grant = KINDS.find((k) => k === request.body?.grant);
        return answerRequest(request.params.id, user, request.body?.accept === true, grant, toStream(request.body?.stream));
      })
  );

  // The stream page's people panel: everyone connected and what they're
  // doing, and the player's (or an admin's) say over each of them.
  /** pads: how many controllers the asking page has joined to the game. */
  app.get<{ Querystring: { pads?: string } }>("/api/sessions/people", { preHandler: requireAuth, logLevel: "warn" }, (request, reply) =>
    withUser(request, reply, (user) => {
      const pads = request.query.pads;
      return people(user, pads === undefined ? undefined : Number(pads));
    })
  );

  app.post<{ Params: { id: string }; Body: { action?: string; stream?: unknown } }>(
    "/api/sessions/people/:id",
    { preHandler: requireAuth },
    (request, reply) =>
      withUser(request, reply, (user) => {
        const action = ACTIONS.find((a) => a === request.body?.action);
        if (!action) return { error: "Unknown action." };
        return manage(user, Number(request.params.id), action, toStream(request.body?.stream));
      })
  );

  /** A guest taking up the player's offer of the PC. */
  app.post<{ Params: { id: string }; Body: { accept?: boolean } }>(
    "/api/sessions/offers/:id/answer",
    { preHandler: requireAuth },
    (request, reply) => withUser(request, reply, (user) => answerOffer(request.params.id, user, request.body?.accept === true))
  );

  // The stream page, just before connecting: a session running with someone
  // else's saves is closed first so this player's load (savesReady.ts).
  app.post("/api/sessions/prepare", { preHandler: requireAuth }, async (request, reply) => {
    const user = await streamUser(request);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const result = await prepareSaves(user);
    if ("error" in result) return reply.code(409).send(result);
    if (result.restarted) request.log.info({ player: user.name }, "closed the last player's session so their saves load");
    return result;
  });

  app.post("/api/sessions/queue", { preHandler: requireAuth }, (request, reply) =>
    withUser(request, reply, (user) => {
      const result = joinQueue(user);
      if (!("error" in result)) void notify(`⏳ ${user.name} is waiting for the PC`, `queue:${user.id}`, 10 * 60_000);
      return result;
    })
  );

  app.get("/api/sessions/queue", { preHandler: requireAuth, logLevel: "warn" }, (request, reply) =>
    withUser(request, reply, (user) => checkQueue(user))
  );

  app.delete("/api/sessions/queue", { preHandler: requireAuth }, (request, reply) =>
    withUser(request, reply, (user) => {
      leaveQueue(user);
      return { ok: true };
    })
  );
}
