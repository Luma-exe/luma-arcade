import { getSetting } from "../config/settings.js";
import { MOONLIGHT_PATH_PREFIX } from "../remote/moonlightWebStream.js";
import { linkForUser, linkState } from "./guestLinks.js";
import { clearStreamUserCache, streamSessionCookie, streamUserFromCookie } from "./streamUser.js";

// Guest-link accounts (guestLinks.ts) get moonlight-web-stream's normal
// sign-in, which lasts 30 days. That's long for a link that may have been
// passed around, so a guest's session ends:
//  - once their link has expired or been turned off, and
//  - after IDLE_MS without the arcade being open with it.
// Opening the link again signs them back in while it's still valid.

export const GUEST_IDLE_MS = 6 * 60 * 60_000;

/** Guest sessions -> when they were last used. */
const lastSeen = new Map<string, number>();

export type GuestSessionCheck = "ok" | "ended";

/** Checks (and keeps fresh) the session behind this cookie; ends it if it's
 * a guest's that should be over. */
export async function checkGuestSession(cookieHeader: string | undefined, now = Date.now()): Promise<GuestSessionCheck> {
  const session = streamSessionCookie(cookieHeader);
  if (!session) return "ok";
  const user = await streamUserFromCookie(cookieHeader);
  if (!user || user.admin) return "ok";
  let link;
  try {
    link = linkForUser(user.id);
  } catch {
    return "ok"; // no database
  }
  if (!link) return "ok"; // a real account
  const state = linkState(link, now);
  const last = lastSeen.get(session);
  if (state === "expired" || state === "revoked" || (last !== undefined && now - last > GUEST_IDLE_MS)) {
    await endSession(cookieHeader ?? "");
    lastSeen.delete(session);
    return "ended";
  }
  lastSeen.set(session, now);
  if (lastSeen.size > 2000) {
    for (const [key, at] of lastSeen) if (now - at > GUEST_IDLE_MS) lastSeen.delete(key);
  }
  return "ok";
}

async function endSession(cookieHeader: string): Promise<void> {
  try {
    const port = getSetting("moonlightWebStreamPort");
    await fetch(`http://127.0.0.1:${port}${MOONLIGHT_PATH_PREFIX}/api/logout`, {
      method: "POST",
      headers: { cookie: cookieHeader },
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    // moonlight-web-stream restarting: the 401 below still sends them to sign in
  }
  clearStreamUserCache();
}

/** Tests. */
export function resetGuestSessions(): void {
  lastSeen.clear();
}

export const GUEST_SESSION_ENDED = "Your guest session has ended. Open your guest link again to carry on.";
