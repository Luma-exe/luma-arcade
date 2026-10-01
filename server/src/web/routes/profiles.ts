import type { FastifyInstance, FastifyRequest } from "fastify";
import { seatAt, seatHolder } from "../seats.js";
import { currentPlayer } from "../sessions.js";

// Per-player saves (host/profiles.ps1): Sunshine runs that script before it
// starts ES-DE, and it asks here whose stream is starting so it can point
// the emulators' save folders at that person's copy.

/** Straight from this PC, not through cloudflared or the LAN: the script
 * calls http://127.0.0.1 with no proxy headers. */
function fromThisPc(request: FastifyRequest): boolean {
  const remote = request.raw.socket.remoteAddress ?? "";
  const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  const proxied = "x-forwarded-for" in request.headers || "cf-connecting-ip" in request.headers;
  return loopback && !proxied;
}

/** An extra seat asking for itself: straight from its own address on the
 * LAN (seats.ts), not through a proxy. Its own copy of the script switches
 * its own saves for whoever has that seat. */
function fromSeat(request: FastifyRequest) {
  const proxied = "x-forwarded-for" in request.headers || "cf-connecting-ip" in request.headers;
  const remote = (request.raw.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  return proxied ? null : seatAt(remote);
}

export async function registerProfileRoutes(app: FastifyInstance) {
  app.get("/api/profiles/current", async (request, reply) => {
    const seat = fromSeat(request);
    if (seat) {
      const user = seatHolder(seat.hostId);
      return { user: user ? { id: user.id, name: user.name } : null, seat: seat.name };
    }
    if (!fromThisPc(request)) return reply.code(403).send({ error: "Only the PC itself can ask this" });
    const user = currentPlayer();
    return { user: user ? { id: user.id, name: user.name } : null };
  });
}
