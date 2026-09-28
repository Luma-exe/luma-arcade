import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { activeAnnouncements } from "../announcements.js";
import { timeLeft } from "../limits.js";
import { recordQuality, type QualitySample } from "../playLog.js";
import { requireAuth } from "../session.js";
import { answerInvite, createInvite, endInvite, invitesFor, invitesFrom, recordActivity, recordStream, type CoopStream } from "../sessions.js";
import { guestUserIds } from "../guestLinks.js";
import { streamUser, type StreamUser } from "../streamUser.js";
import { listUsers } from "../../remote/moonlightData.js";

// What pages poll while someone plays or browses: co-op invites (sessions.ts),
// the stream page's 30-second report (idle time + stream quality, answered
// with time left and announcements), and everyone's view of announcements.

async function withUser(request: FastifyRequest, reply: FastifyReply, run: (user: StreamUser) => unknown): Promise<unknown> {
  const user = await streamUser(request);
  if (!user) return reply.code(401).send({ error: "unauthorized" });
  const result = run(user);
  if (result && typeof result === "object" && "error" in result) return reply.code(409).send(result);
  return result;
}

function toStream(body: unknown): CoopStream | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const n = (k: string) => Number(b[k]);
  const stream = { hostId: n("hostId"), appId: n("appId"), width: n("width"), height: n("height"), fps: n("fps") };
  const ok = Object.values(stream).every((v) => Number.isSafeInteger(v) && v >= 0) && stream.width > 0 && stream.height > 0 && stream.fps > 0;
  return ok ? stream : null;
}

export async function registerCoopRoutes(app: FastifyInstance) {
  /** Invites for me, the co-op I'm hosting, and who I could invite. */
  app.get("/api/coop", { preHandler: requireAuth }, (request, reply) =>
    withUser(request, reply, (user) => {
      let people: { id: number; name: string }[] = [];
      try {
        const guests = guestUserIds();
        people = listUsers()
          .filter((u) => u.id !== user.id && !guests.has(u.id))
          .map((u) => ({ id: u.id, name: u.name }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        // moonlight-web-stream's data file unreadable: no list to pick from
      }
      return { invites: invitesFor(user), mine: invitesFrom(user), people };
    })
  );

  app.post<{ Body: { userId?: number; stream?: unknown } }>("/api/coop/invite", { preHandler: requireAuth }, (request, reply) =>
    withUser(request, reply, (user) => {
      const stream = toStream(request.body?.stream);
      if (!stream) return { error: "Missing the stream to share." };
      let to: StreamUser | null = null;
      try {
        const u = listUsers().find((x) => x.id === Number(request.body?.userId));
        if (u) to = { id: u.id, name: u.name, roleId: u.roleId, admin: false };
      } catch {}
      if (!to) return { error: "No such person." };
      return createInvite(user, to, stream);
    })
  );

  app.post<{ Params: { id: string }; Body: { accept?: boolean } }>("/api/coop/:id/answer", { preHandler: requireAuth }, (request, reply) =>
    withUser(request, reply, (user) => answerInvite(request.params.id, user, request.body?.accept === true))
  );

  app.delete<{ Params: { id: string } }>("/api/coop/:id", { preHandler: requireAuth }, (request, reply) =>
    withUser(request, reply, (user) => endInvite(request.params.id, user))
  );

  /** The stream page's report every 30 s (activity.js). */
  app.post<{ Body: { idleMs?: number; quality?: QualitySample; stream?: unknown } }>("/api/sessions/activity", { preHandler: requireAuth }, (request, reply) =>
    withUser(request, reply, (user) => {
      recordActivity(user, Number(request.body?.idleMs));
      // What a player-2 guest link would join with (routes/guestLinks.ts).
      const stream = toStream(request.body?.stream);
      if (stream) recordStream(user, stream);
      const q = request.body?.quality;
      if (q && typeof q === "object") {
        try {
          recordQuality(user.id, q);
        } catch {
          // no database (tests) or a bad sample: skip it
        }
      }
      let left: ReturnType<typeof timeLeft> | null = null;
      try {
        left = timeLeft(user);
      } catch {}
      return { remainingMs: left?.remainingMs ?? null, announcements: announcementsOrNone() };
    })
  );

  app.get("/api/announcements", { preHandler: requireAuth }, async () => ({ announcements: announcementsOrNone() }));

  /** My play time today / this week and what's left. */
  app.get("/api/limits/me", { preHandler: requireAuth }, (request, reply) => withUser(request, reply, (user) => timeLeft(user)));
}

function announcementsOrNone() {
  try {
    return activeAnnouncements();
  } catch {
    return [];
  }
}
