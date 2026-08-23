import type { FastifyReply, FastifyRequest } from "fastify";
import { isSessionValid } from "./auth.js";

export const SESSION_COOKIE = "luma_session";

export function getSessionId(request: FastifyRequest): string | undefined {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return undefined;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? (unsigned.value ?? undefined) : undefined;
}

export function setSessionCookie(reply: FastifyReply, sessionId: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    path: "/",
    httpOnly: true,
    secure: false, // LAN-only, plain HTTP in Phase 1
    sameSite: "lax",
    signed: true,
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sessionId = getSessionId(request);
  if (!sessionId || !isSessionValid(sessionId)) {
    reply.code(401).send({ error: "unauthorized" });
    return;
  }
}
