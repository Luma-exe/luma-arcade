import type { FastifyInstance } from "fastify";
import { readData } from "../../remote/moonlightData.js";
import { createReadStream } from "node:fs";
import path from "node:path";
import { getDb } from "../../db/index.js";
import { coverFile, currentGame, gamesByUser, lastGameFor, launchableGames, playById, takeQueuedLaunch, type GamePlay } from "../games.js";
import { playSummary } from "../playLog.js";
import { requireAuth } from "../session.js";
import { currentPlayer, isPlayingNow, nowStreaming } from "../sessions.js";
import { requireAdmin, streamUser, type StreamUser } from "../streamUser.js";
import { sunshineAppId } from "../sunshine.js";
import { runHome } from "./home.js";

// "Continue playing": the home screen offers what you played last; the
// stream page, once your stream is up (?continue=1), asks for it to start.

/** The paired PC's id in moonlight-web-stream (its only host). */
function localHostId(): number | null {
  try {
    for (const [id, host] of Object.entries(readData().hosts ?? {})) {
      if (/^(localhost|127\.0\.0\.1|::1)$/.test(host.address)) return Number(id);
    }
  } catch {}
  return null;
}

/** The stream a game is played in: this PC, and the app (ES-DE) it was
 * started from. Null when that app is gone. (An object, so tests can swap it.) */
export const gameStreams = {
  async find(game: Pick<GamePlay, "app">): Promise<{ hostId: number; appId: number } | null> {
    const hostId = localHostId();
    const appId = await sunshineAppId(game.app).catch(() => null);
    return hostId !== null && appId !== null ? { hostId, appId } : null;
  },
};

/** What this person can continue, and the stream to start it in (also a part of /api/poll). */
export async function continueFor(user: StreamUser) {
  const game = lastGameFor(user);
  if (!game) return { game: null, stream: null };
  return {
    game: { title: game.title, system: game.system, playedAt: game.startedAt, coverId: coverFile(game) ? game.id : null },
    stream: await gameStreams.find(game),
  };
}

/** Whether this person lets the welcome page say what they're playing. */
export function sharesPlaying(userId: number): boolean {
  const row = getDb().prepare("SELECT share_playing FROM user_prefs WHERE user_id = ?").get(userId) as { share_playing: number } | undefined;
  return !!row?.share_playing;
}

/** For the public welcome page: only people who said so, and only their name and game. */
export function publicPlaying(): { name: string; game: string | null; role: "player" | "player2" | "spectator" }[] {
  const game = currentGame();
  const player = currentPlayer();
  return nowStreaming()
    .filter((s) => sharesPlaying(s.user.id))
    .map((s) => ({
      name: s.user.name,
      role: s.role,
      // The game on the PC is the player's; guests play (or watch) along.
      game: game && (s.role !== "player" || player?.id === s.user.id) ? game.title : null,
    }));
}

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

export async function registerGameRoutes(app: FastifyInstance) {
  /** ES-DE's cover for a play (games.ts coverFile), for "Continue", "My play" and the admin screen. */
  app.get<{ Params: { id: string } }>("/api/games/:id/cover", { preHandler: requireAuth, logLevel: "warn" }, async (request, reply) => {
    const play = playById(Number(request.params.id));
    const file = play ? coverFile(play) : null;
    if (!file) return reply.code(404).send({ error: "No cover" });
    return reply
      .header("cache-control", "private, max-age=86400")
      .type(IMAGE_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream")
      .send(createReadStream(file));
  });

  /** "My play" in the settings screen: this week's play time and games. */
  app.get("/api/me/play", { preHandler: requireAuth, logLevel: "warn" }, async (request, reply) => {
    const user = await streamUser(request);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const summary = playSummary(7, 0);
    const mine = summary.byUser.find((u) => u.userId === user.id);
    const games = (gamesByUser(summary.since).get(user.id) ?? []).slice(0, 8).map((g) => {
      const play = playById(g.coverId);
      return { title: g.title, ms: g.ms, plays: g.plays, coverId: play && coverFile(play) ? g.coverId : null };
    });
    return { weekMs: mine?.ms ?? 0, sessions: mine?.sessions ?? 0, games, sharePlaying: sharesPlaying(user.id) };
  });

  app.put<{ Body: { sharePlaying?: unknown } }>("/api/me/prefs", { preHandler: requireAuth }, async (request, reply) => {
    const user = await streamUser(request);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const share = request.body?.sharePlaying === true ? 1 : 0;
    getDb()
      .prepare("INSERT INTO user_prefs (user_id, share_playing, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET share_playing = excluded.share_playing, updated_at = excluded.updated_at")
      .run(user.id, share, Date.now());
    return { sharePlaying: !!share };
  });

  /** The welcome page's "Now playing": public, so only people who opted in. */
  app.get("/api/public/playing", { logLevel: "warn" }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { playing: publicPlaying() };
  });

  /** Games a guest link can open straight into (anything played here before). */
  app.get("/api/admin/games", { preHandler: requireAdmin, logLevel: "warn" }, async () => ({ games: launchableGames() }));

  app.get("/api/continue", { preHandler: requireAuth, logLevel: "warn" }, async (request, reply) => {
    const user = await streamUser(request);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    return continueFor(user);
  });

  app.post("/api/continue", { preHandler: requireAuth }, async (request, reply) => {
    const user = await streamUser(request);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    if (!isPlayingNow(user.id)) return reply.code(409).send({ error: "Start streaming first" });
    // A guest link's game first (routes/guestLinks.ts), else their own last one.
    const game = takeQueuedLaunch(user.id) ?? lastGameFor(user);
    if (!game) return reply.code(404).send({ error: "Nothing to continue" });
    request.log.info({ player: user.name, game: game.title }, "continue playing");
    try {
      return await runHome<{ ok: boolean; error?: string; launched?: string }>(
        { action: "launch", name: game.title, system: game.system, rom: game.rom, exe: game.exe, commandLine: game.commandLine },
        30_000
      );
    } catch (err) {
      return reply.code(503).send({ ok: false, error: (err as Error).message });
    }
  });
}
