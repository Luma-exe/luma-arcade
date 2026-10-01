import type { FastifyInstance, FastifyRequest } from "fastify";
import { arrive, arrived, fetchTo, lastPc, MAIN } from "../saveSync.js";
import { requireAuth } from "../session.js";
import { streamUser } from "../streamUser.js";
import { listSeats, seatAt, seatHolder } from "../seats.js";
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

  // Saves follow their player between PCs (saveSync.ts). The asking PC's
  // switch calls arrive before loading someone's saves, and arrived once it
  // imported what it was handed. Only for the player on that PC right now.
  const askingPc = (request: FastifyRequest): { pc: string; player: { id: number; name: string } | null } | null => {
    const seat = fromSeat(request);
    if (seat) {
      const user = seatHolder(seat.hostId);
      return { pc: seat.name, player: user ? { id: user.id, name: user.name } : null };
    }
    if (!fromThisPc(request)) return null;
    const user = currentPlayer();
    return { pc: MAIN, player: user ? { id: user.id, name: user.name } : null };
  };

  app.post<{ Body: { player?: string | number } }>("/api/saves/arrive", async (request, reply) => {
    const asking = askingPc(request);
    if (!asking) return reply.code(403).send({ error: "Only a PC itself can ask this" });
    if (!asking.player || String(asking.player.id) !== String(request.body?.player)) {
      return reply.code(409).send({ error: "That isn't who is playing on this PC" });
    }
    try {
      const answer = await arrive(asking.player, asking.pc, listSeats());
      if (answer.import) request.log.info({ player: asking.player.name, from: answer.from, to: asking.pc }, "saves moved");
      return answer;
    } catch (err) {
      request.log.warn({ player: asking.player.name, to: asking.pc, err: (err as Error).message }, "couldn't move saves");
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // The stream page, before it connects: the signed-in player's latest saves
  // brought to the PC they're about to play on (saveSync.ts fetchTo), so the
  // move happens on the connect screen, not in the middle of the launch.
  app.post<{ Body: { hostId?: number | string } }>("/api/saves/fetch", { preHandler: requireAuth }, async (request, reply) => {
    const user = await streamUser(request);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const hostId = Number(request.body?.hostId);
    const seat = hostId ? listSeats().find((s) => s.hostId === hostId) : undefined;
    const pc = seat ? seat.name : MAIN;
    try {
      const answer = await fetchTo({ id: user.id, name: user.name }, pc, listSeats());
      if (answer.moved) request.log.info({ player: user.name, from: answer.from, to: pc }, "saves moved");
      return answer;
    } catch (err) {
      request.log.warn({ player: user.name, to: pc, err: (err as Error).message }, "couldn't move saves");
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // Where would they come from? (The page says so while it waits.)
  app.get<{ Querystring: { hostId?: string } }>("/api/saves/where", { preHandler: requireAuth, logLevel: "warn" }, async (request, reply) => {
    const user = await streamUser(request);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const hostId = Number(request.query.hostId);
    const seat = hostId ? listSeats().find((s) => s.hostId === hostId) : undefined;
    const pc = seat ? seat.name : MAIN;
    const last = lastPc(user.id);
    return { here: pc, last, needsMove: last !== pc, lastName: last === MAIN ? "MainServer" : last };
  });

  app.post<{ Body: { player?: string | number; ok?: boolean } }>("/api/saves/arrived", async (request, reply) => {
    const asking = askingPc(request);
    if (!asking) return reply.code(403).send({ error: "Only a PC itself can say this" });
    const id = Number(request.body?.player);
    if (!asking.player || asking.player.id !== id) return reply.code(409).send({ error: "That isn't who is playing on this PC" });
    arrived(id, asking.pc, !!request.body?.ok);
    return { ok: true };
  });
}
