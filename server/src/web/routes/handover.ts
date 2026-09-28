import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../session.js";
import { streamUser, type StreamUser } from "../streamUser.js";
import {
  answerRequest,
  cancelRequest,
  checkQueue,
  getRequest,
  inbox,
  joinQueue,
  leaveQueue,
  requestHandover,
} from "../sessions.js";

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
  app.post("/api/sessions/handover", { preHandler: requireAuth }, (request, reply) =>
    withUser(request, reply, (user) => requestHandover(user))
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

  app.get("/api/sessions/handover-inbox", { preHandler: requireAuth }, (request, reply) =>
    withUser(request, reply, (user) => inbox(user))
  );

  app.post<{ Params: { id: string }; Body: { accept?: boolean } }>(
    "/api/sessions/handover/:id/answer",
    { preHandler: requireAuth },
    (request, reply) => withUser(request, reply, (user) => answerRequest(request.params.id, user, request.body?.accept === true))
  );

  app.post("/api/sessions/queue", { preHandler: requireAuth }, (request, reply) =>
    withUser(request, reply, (user) => joinQueue(user))
  );

  app.get("/api/sessions/queue", { preHandler: requireAuth }, (request, reply) =>
    withUser(request, reply, (user) => checkQueue(user))
  );

  app.delete("/api/sessions/queue", { preHandler: requireAuth }, (request, reply) =>
    withUser(request, reply, (user) => {
      leaveQueue(user);
      return { ok: true };
    })
  );
}
