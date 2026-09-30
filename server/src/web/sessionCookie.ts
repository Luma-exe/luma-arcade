// moonlight-web-stream's session cookie is "SameSite=Strict" with only an
// Expires date. Some browsers dropped it right after a good sign-in ("Login
// was successful but authentication doesn't work!", then 401s):
//  - Expires is read against the device's clock, so a phone whose clock is
//    off treats the cookie as already expired. Max-Age is counted from now
//    and wins over Expires.
//  - Strict cookies are withheld when the arcade was opened from a link in
//    another app or site (chat apps' in-app browsers, guest links). Lax still
//    keeps them off other sites' POSTs.

/** One Set-Cookie value, made sturdier if it's moonlight-web-stream's session. */
export function sturdySessionCookie(cookie: string, now = Date.now()): string {
  if (!/^mlSession=/i.test(cookie)) return cookie;
  const parts = cookie.split(";").map((p) => p.trim());
  const expires = parts.find((p) => /^expires=/i.test(p));
  const out = parts.map((p) => (/^samesite=strict$/i.test(p) ? "SameSite=Lax" : p));
  if (expires && !parts.some((p) => /^max-age=/i.test(p))) {
    const at = Date.parse(expires.slice("expires=".length));
    if (!Number.isNaN(at)) out.push(`Max-Age=${Math.max(0, Math.round((at - now) / 1000))}`);
  }
  return out.join("; ");
}

/** A response's set-cookie header (string, list or missing), made sturdier. */
export function sturdySetCookieHeader<T extends string | string[] | undefined>(header: T, now = Date.now()): T {
  if (header === undefined) return header;
  if (Array.isArray(header)) return header.map((c) => sturdySessionCookie(c, now)) as T;
  return sturdySessionCookie(header as string, now) as T;
}
