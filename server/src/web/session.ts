import type { FastifyReply, FastifyRequest } from "fastify";
import { isSessionValid } from "./auth.js";
import { isHttpsRequest } from "./requestOrigin.js";

export const SESSION_COOKIE = "luma_session";

export function getSessionId(request: FastifyRequest): string | undefined {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return undefined;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? (unsigned.value ?? undefined) : undefined;
}

export function setSessionCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  sessionId: string,
  expiresAt: Date
): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    path: "/",
    httpOnly: true,
    // Secure over the public HTTPS tunnel; plain HTTP on the LAN still works.
    secure: isHttpsRequest(request),
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
  }
}
