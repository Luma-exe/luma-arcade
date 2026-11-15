// Sign-in rate limit for moonlight-web-stream's login, which LumaArcade
// proxies (routes/moonlight.ts): a simple in-memory sliding window per IP.
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;

const MAX_TRACKED = 5000;

/** What a visitor is counted as: a whole IPv6 /64 (one home or one phone
 * hands out billions of addresses), an IPv4 address as is. */
export function rateKey(ip: string): string {
  if (!ip.includes(":") || ip.toLowerCase().startsWith("::ffff:")) return ip;
  // Home-network addresses (loopback, link-local fe80::, unique-local fc/fd)
  // keep their own bucket, so one LAN device's typos don't lock out the rest.
  if (/^(::1$|fe[89ab]|f[cd])/i.test(ip)) return ip.toLowerCase();
  const [head] = ip.toLowerCase().split("%");
  const [before, after] = head.split("::");
  const front = before ? before.split(":") : [];
  const back = after ? after.split(":") : [];
  const groups = head.includes("::") ? [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back] : front;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":");
}

function prune(now: number): void {
  if (attempts.size <= MAX_TRACKED) return;
  for (const [key, entry] of attempts) if (entry.resetAt < now) attempts.delete(key);
}

export function isRateLimited(address: string): boolean {
  const entry = attempts.get(rateKey(address));
  if (!entry || entry.resetAt < Date.now()) return false;
  return entry.count >= MAX_ATTEMPTS;
}

export function recordFailedAttempt(address: string): void {
  const ip = rateKey(address);
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    prune(now);
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  entry.count += 1;
}

export function clearAttempts(ip: string): void {
  attempts.delete(rateKey(ip));
}
