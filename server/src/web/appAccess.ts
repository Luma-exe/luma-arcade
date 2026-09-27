import type { FastifyReply, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import { getAccess, isAppAllowed, type UserAccess } from "./access.js";
import { decide, streamEnded, streamStarted } from "./sessions.js";
import { streamUser, type StreamUser } from "./streamUser.js";

// Enforces "which apps may this person start" (admin screen) in the
// /stream proxy: their app list only shows allowed apps, and a stream for
// any other app is refused when its WebSocket says which app it wants.

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
  if (who.access?.apps) {
    const title = appTitles.get(`${init.host_id}:${init.app_id}`);
    if (!isAppAllowed(who.access, title)) {
      return refuse(4003, title ? `You don't have access to ${title}` : "You don't have access to that app");
    }
  }
  // One PC, one screen: someone else's game isn't yours to join (sessions.ts).
  const decision = decide(who.user);
  if (!decision.allowed) return refuse(4009, decision.reason ?? "Someone else is using this PC");
  streamStarted(source, who.user);
}

/** wsHooks.onDisconnect */
export function streamClosed(source: WsLike): void {
  streamEnded(source);
}
