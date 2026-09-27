import type { FastifyReply, FastifyRequest } from "fastify";
import { getSetting } from "../config/settings.js";
import { MOONLIGHT_PATH_PREFIX } from "../remote/moonlightWebStream.js";

// LumaArcade's own login is one shared password; the people behind it are
// moonlight-web-stream's users (its "mlSession" cookie). This asks
// moonlight-web-stream who a request's cookie belongs to.

export interface StreamUser {
  id: number;
  name: string;
  roleId: number;
  admin: boolean;
}

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; user: StreamUser | null }>();

export function streamSessionCookie(cookieHeader: string | undefined): string | null {
  const m = /(?:^|;\s*)mlSession=([^;]+)/.exec(cookieHeader ?? "");
  return m ? m[1] : null;
}

export async function streamUserFromCookie(cookieHeader: string | undefined): Promise<StreamUser | null> {
  // The whole cookie header goes along, so this keeps working whatever
  // moonlight-web-stream calls its session cookie; its value is the cache key.
  const session = streamSessionCookie(cookieHeader) ?? cookieHeader ?? null;
  if (!session) return null;
  const hit = cache.get(session);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.user;

  let user: StreamUser | null = null;
  try {
    const port = getSetting("moonlightWebStreamPort");
    const res = await fetch(`http://127.0.0.1:${port}${MOONLIGHT_PATH_PREFIX}/api/user`, {
      headers: { cookie: cookieHeader ?? "" },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const body = (await res.json()) as { id: number; name: string; role: string; role_id: number };
      user = { id: body.id, name: body.name, roleId: body.role_id, admin: body.role === "Admin" };
    }
  } catch {
    // moonlight-web-stream restarting: treat as not signed in for now
    return null;
  }
  cache.set(session, { at: Date.now(), user });
  if (cache.size > 500) {
    for (const [key, value] of cache) if (Date.now() - value.at > CACHE_MS) cache.delete(key);
  }
  return user;
}

export function streamUser(request: FastifyRequest): Promise<StreamUser | null> {
  return streamUserFromCookie(request.headers.cookie);
}

/** Forget cached identities, e.g. after an admin changed someone's role. */
export function clearStreamUserCache(): void {
  cache.clear();
}

/** A moonlight-web-stream user with the Admin role. */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await streamUser(request);
  if (!user) {
    reply.code(401).send({ error: "unauthorized" });
  } else if (!user.admin) {
    reply.code(403).send({ error: "Only admins can do that" });
  }
}
