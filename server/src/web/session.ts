import type { FastifyReply, FastifyRequest } from "fastify";
import { GUEST_SESSION_ENDED, checkGuestSession } from "./guestSessions.js";
import { isGuest } from "./sessions.js";
import { streamUser } from "./streamUser.js";

/** Signed in to moonlight-web-stream (its session cookie reaches LumaArcade
 * on /stream/... requests, see server.ts). That one sign-in replaced
 * LumaArcade's old shared portal password. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // A guest's session that should be over ends here (guestSessions.ts).
  if ((await checkGuestSession(request.headers.cookie)) === "ended") {
    reply.code(401).send({ error: GUEST_SESSION_ENDED });
    return;
  }
  if (!(await streamUser(request))) {
    reply.code(401).send({ error: "unauthorized" });
  }
}

/** Signed in, and not just a co-op guest in someone else's game: guests
 * play along but don't go Home, switch windows or close the game. */
export async function requireOwnerOrFree(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await streamUser(request);
  if (!user) {
    reply.code(401).send({ error: "unauthorized" });
  } else if (isGuest(user)) {
    reply.code(403).send({ error: "You're playing along as a guest; only the person you joined can do that." });
  }
}
