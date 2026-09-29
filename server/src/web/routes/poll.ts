import type { FastifyInstance } from "fastify";
import { timeLeft } from "../limits.js";
import { takeMessages } from "../messages.js";
import { requireAuth } from "../session.js";
import { inbox, people } from "../sessions.js";
import { streamUser } from "../streamUser.js";
import { announcementsOrNone, coopView } from "./coop.js";
import { continueFor } from "./games.js";

// Everything a page keeps checking, in one request: it names the parts it
// wants this time (moonlight static/component/poll.js), instead of each part
// polling on its own (five requests every few seconds per tab). The parts
// are the same answers as their own routes, which stay for other callers.
//
// Polled routes log at "warn": a request line every second or two per tab
// was ~90% of the log.
const PARTS = ["messages", "inbox", "people", "coop", "announcements", "limits", "continue"] as const;

export async function registerPollRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { parts?: string; pads?: string } }>(
    "/api/poll",
    { preHandler: requireAuth, logLevel: "warn" },
    async (request, reply) => {
      const user = await streamUser(request);
      if (!user) return reply.code(401).send({ error: "unauthorized" });
      const asked = new Set((request.query.parts ?? "").split(","));
      const pads = request.query.pads;
      const out: Record<string, unknown> = {};
      for (const part of PARTS) {
        if (!asked.has(part)) continue;
        try {
          if (part === "messages") out.messages = { messages: takeMessages(user.id) };
          else if (part === "inbox") out.inbox = inbox(user);
          else if (part === "people") out.people = people(user, pads === undefined || pads === "" ? undefined : Number(pads));
          else if (part === "coop") out.coop = coopView(user);
          else if (part === "announcements") out.announcements = { announcements: announcementsOrNone() };
          else if (part === "limits") out.limits = timeLeft(user);
          else if (part === "continue") out.continue = await continueFor(user);
        } catch (err) {
          // One part failing doesn't take the others with it.
          request.log.warn({ err, part }, "poll part failed");
          out[part] = { error: "unavailable" };
        }
      }
      return out;
    }
  );
}
