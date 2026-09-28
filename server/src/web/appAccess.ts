import type { FastifyReply, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import { getAccess, isAppAllowed, type UserAccess } from "./access.js";
import { timeLeft } from "./limits.js";
import { playEnded, playStarted } from "./playLog.js";
import { decide, guestStream, streamEnded, streamStarted } from "./sessions.js";
import { streamUser, type StreamUser } from "./streamUser.js";

// Enforces "which apps may this person start" (admin screen) in the
// /stream proxy: their app list only shows allowed apps, and a stream for
// any other app is refused when its WebSocket says which app it wants.
// Streams are also refused past a play time limit (limits.ts), and ended
// when they run into one.

interface AppEntry {
  app_id: number;
  title?: string;
  name?: string;
}

/** host id + app id -> app title, learned from app lists passing through. */
const appTitles = new Map<string, string>();

/** Whoever opened each upgrade connection, and their app access (null =
 * every app), keyed by its socket. */
const socketAccess = new WeakMap<object, { user: StreamUser; access: UserAccess | null }>();

/** Open streams: who, and their play_sessions row (playLog.ts). */
const openStreams = new Map<WsLike, { user: StreamUser; row: number | null }>();

/** How often running streams are checked against time limits. */
const LIMIT_CHECK_MS = 30_000;

export function isAppListRequest(request: FastifyRequest, prefix: string): boolean {
  return request.method === "GET" && request.url.split("?")[0] === `${prefix}/api/apps`;
}

/** Proxy preHandler part: remember who is behind a WebSocket upgrade. */
export async function rememberSocketAccess(request: FastifyRequest): Promise<void> {
  if (request.headers.upgrade?.toLowerCase() !== "websocket") return;
  const user = await streamUser(request);
  if (user) socketAccess.set(request.raw.socket, { user, access: user.admin ? null : getAccess(user.id) });
}

/** reply-from onResponse for /api/apps: drop apps this person can't use. */
export async function filterAppList(
  request: FastifyRequest,
  reply: FastifyReply,
  upstream: { stream: Readable }
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of upstream.stream) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks);
  try {
    const body = JSON.parse(raw.toString("utf8")) as { apps?: AppEntry[] };
    if (!Array.isArray(body.apps)) return void reply.send(raw);
    const hostId = new URL(request.url, "http://x").searchParams.get("host_id") ?? "";
    for (const app of body.apps) appTitles.set(`${hostId}:${app.app_id}`, app.title ?? app.name ?? "");

    const user = await streamUser(request);
    const access = user && !user.admin ? getAccess(user.id) : null;
    if (access?.apps) {
      body.apps = body.apps.filter((app) => isAppAllowed(access, app.title ?? app.name));
    }
    reply.removeHeader("content-length");
    reply.send(JSON.stringify(body));
  } catch {
    reply.send(raw);
  }
}

interface WsLike {
  _socket?: object;
  close(code?: number, reason?: string): void;
  terminate?(): void;
}

/** wsHooks.onIncomingMessage: check the stream's Init message. */
export function checkStreamInit(source: WsLike, target: WsLike, data: unknown, binary: boolean): void {
  if (binary || !source._socket) return;
  const who = socketAccess.get(source._socket);
  if (!who) return;
  let message: { Init?: { host_id?: number; app_id?: number } };
  try {
    message = JSON.parse(String(data));
  } catch {
    return;
  }
  const init = message?.Init;
  if (!init) return;
  // Stop refused streams before moonlight-web-stream starts anything.
  const refuse = (code: number, reason: string) => {
    try {
      target.terminate?.();
    } catch {
      // already gone
    }
    source.close(code, reason.slice(0, 120));
  };
  const title = appTitles.get(`${init.host_id}:${init.app_id}`);
  if (who.access?.apps) {
    if (!isAppAllowed(who.access, title)) {
      return refuse(4003, title ? `You don't have access to ${title}` : "You don't have access to that app");
    }
  }
  // Out of play time (limits.ts).
  let left: ReturnType<typeof timeLeft> | null = null;
  try {
    left = timeLeft(who.user);
  } catch {
    // no database: no limits
  }
  if (left?.remainingMs === 0) return refuse(4012, left.reason ?? "You're out of play time");
  // One PC, one screen: someone else's game isn't yours to join (sessions.ts).
  const decision = decide(who.user);
  if (!decision.allowed) return refuse(4009, decision.reason ?? "Someone else is using this PC");
  if (decision.guest) {
    // Co-op: only the game you were invited into.
    const coop = guestStream(who.user);
    if (coop && (coop.hostId !== init.host_id || coop.appId !== init.app_id)) {
      return refuse(4013, `Join ${decision.ownerName}'s game from their invite`);
    }
  }
  const role = streamStarted(source, who.user);
  let row: number | null = null;
  try {
    row = playStarted(who.user.id, who.user.name, title || `App ${init.app_id ?? "?"}`, Date.now(), role === "guest");
  } catch {
    // the play log is a nice-to-have; never let it stop a stream
  }
  openStreams.set(source, { user: who.user, row });
}

/** End this person's streams now (an admin kicking a guest). */
export function closeStreamsOf(userId: number, reason: string): number {
  let closed = 0;
  for (const [socket, s] of openStreams) {
    if (s.user.id !== userId) continue;
    try {
      socket.close(4014, reason.slice(0, 120));
    } catch {
      // already gone
    }
    streamClosed(socket);
    closed++;
  }
  return closed;
}

/** End streams whose player has run out of play time. */
export function enforceTimeLimits(now = Date.now()): void {
  for (const [socket, s] of openStreams) {
    let left;
    try {
      left = timeLeft(s.user, now);
    } catch {
      return;
    }
    if (left.remainingMs !== 0) continue;
    try {
      socket.close(4012, (left.reason ?? "You're out of play time").slice(0, 120));
    } catch {
      // already gone
    }
    streamClosed(socket);
  }
}

if (process.env.NODE_ENV !== "test") setInterval(() => enforceTimeLimits(), LIMIT_CHECK_MS).unref();

/** Stream sockets carry nothing once WebRTC is up, and Cloudflare's tunnel
 * drops a WebSocket after ~100 s without traffic - while the video goes on.
 * That dropped the player from sessions.ts, so the next person walked
 * straight in. A ping every 25 s keeps it open (browsers answer by
 * themselves). */
const KEEPALIVE_MS = 25_000;
const keepalives = new Map<object, ReturnType<typeof setInterval>>();

/** wsHooks.onConnect */
export function streamSocketOpened(source: WsLike & { ping?(): void }): void {
  if (!source.ping || keepalives.has(source)) return;
  const timer = setInterval(() => {
    try {
      source.ping!();
    } catch {
      // closing: onDisconnect clears it
    }
  }, KEEPALIVE_MS);
  timer.unref?.();
  keepalives.set(source, timer);
}

/** Whoever this stream belongs to, for the log. */
export function streamOwnerName(source: WsLike): string | null {
  return openStreams.get(source)?.user.name ?? null;
}

/** wsHooks.onDisconnect */
export function streamClosed(source: WsLike): void {
  const keepalive = keepalives.get(source);
  if (keepalive) {
    clearInterval(keepalive);
    keepalives.delete(source);
  }
  streamEnded(source);
  const open = openStreams.get(source);
  if (!open) return;
  openStreams.delete(source);
  if (open.row === null) return;
  try {
    playEnded(open.row);
  } catch {
    // see above
  }
}
