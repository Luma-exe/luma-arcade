import type { FastifyRequest } from "fastify";

/** Proxies that run on this machine (cloudflared, the Vite dev server) and
 * are therefore allowed to tell us the real client address via
 * X-Forwarded-For / X-Forwarded-Proto. Passed to Fastify's trustProxy. */
export const TRUSTED_PROXIES = ["127.0.0.1", "::1"];

function isLoopback(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function isPrivateAddress(address: string): boolean {
  const ip = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  if (isLoopback(ip)) return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  const lower = ip.toLowerCase();
  return lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
}

/** True when the request came through the Cloudflare tunnel, i.e. from the
 * internet. cloudflared connects from loopback and always adds
 * CF-Connecting-IP; nothing on the LAN can reach us *from* loopback. */
function isViaTunnel(request: FastifyRequest): boolean {
  // socket can already be null (e.g. in a proxy's onResponse), so don't throw.
  return isLoopback(request.socket?.remoteAddress ?? "") && !!request.headers["cf-connecting-ip"];
}

/** The real visitor's IP. Behind the tunnel every socket is 127.0.0.1, which
 * made the per-IP login rate limit one shared bucket for the whole internet
 * (so anyone could lock everyone out by spamming wrong passwords). */
export function clientIp(request: FastifyRequest): string {
  if (isViaTunnel(request)) return String(request.headers["cf-connecting-ip"]);
  return request.ip;
}

/** Requests from this PC or the home LAN, not from the internet. Used to gate
 * things that would be dangerous if the password leaked: first-run password
 * setup and settings that make the host execute a file. */
export function isLocalRequest(request: FastifyRequest): boolean {
  return !isViaTunnel(request) && isPrivateAddress(request.ip);
}

/** For a visit that reached Cloudflare as plain http://, the https:// address
 * to send it to; otherwise null. Safari keeps http:// when that's what was
 * typed or saved, and moonlight-web-stream's sign-in cookie is Secure, so
 * the sign-in "worked" but the next request was a 401. */
export function httpsUpgradeUrl(request: FastifyRequest): string | null {
  if (!isViaTunnel(request)) return null;
  const visitor = String(request.headers["cf-visitor"] ?? "");
  const proto = String(request.headers["x-forwarded-proto"] ?? "");
  if (!/"scheme"\s*:\s*"http"/.test(visitor) && proto !== "http") return null;
  const host = request.headers.host;
  if (!host) return null;
  return `https://${host}${request.raw.url ?? "/"}`;
}
