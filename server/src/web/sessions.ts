import type { StreamUser } from "./streamUser.js";

// One Sunshine host means one desktop: everyone who connects sees the same
// screen. So the PC belongs to whoever started what's running on it until
// it's closed; others can't connect into their game (admins can take over).
// Every moonlight-web-stream "device" here is the same Sunshine, so the
// lock is for the whole PC, not per host id.

const SUNSHINE_SERVERINFO = "http://127.0.0.1:47989/serverinfo";
const POLL_MS = 4000;

interface Streamer {
  user: StreamUser;
  since: number;
}

/** Open stream WebSockets (their client-side socket) -> who. */
const streaming = new Map<object, Streamer>();

/** Who started what's running on the PC; cleared once Sunshine is free. */
let owner: { user: StreamUser; since: number } | null = null;
let sunshineBusy = false;

async function pollSunshine(): Promise<void> {
  try {
    const res = await fetch(SUNSHINE_SERVERINFO, { signal: AbortSignal.timeout(3000) });
    const text = await res.text();
    sunshineBusy = /<state>SUNSHINE_SERVER_BUSY<\/state>/.test(text);
  } catch {
    // Sunshine restarting: keep the last known state
  }
  if (!sunshineBusy && streaming.size === 0) owner = null;
}

setInterval(() => void pollSunshine(), POLL_MS).unref();
void pollSunshine();

function otherStreamer(user: StreamUser): Streamer | null {
  for (const s of streaming.values()) if (s.user.id !== user.id) return s;
  return null;
}

export interface SessionDecision {
  allowed: boolean;
  /** Plain-language reason when not allowed, or a heads-up when it is. */
  reason?: string;
  takeOver?: boolean;
}

/** May this person start or join a stream right now? */
export function decide(user: StreamUser): SessionDecision {
  const other = otherStreamer(user);
  if (other) {
    if (user.admin) {
      return { allowed: true, takeOver: true, reason: `${other.user.name} is playing right now. Connecting takes over their session.` };
    }
    return { allowed: false, reason: `${other.user.name} is playing on this PC right now. Try again when they've finished.` };
  }
  if (owner && owner.user.id !== user.id && sunshineBusy) {
    if (user.admin) {
      return { allowed: true, takeOver: true, reason: `${owner.user.name}'s game is still open on this PC. Connecting takes it over.` };
    }
    return {
      allowed: false,
      reason: `${owner.user.name}'s game is still open on this PC. They can close it with Home → Close game, or an admin can take over.`,
    };
  }
  return { allowed: true };
}

/** The stream's Init message got through: this person has the PC now. */
export function streamStarted(socket: object, user: StreamUser): void {
  streaming.set(socket, { user, since: Date.now() });
  owner = { user, since: Date.now() };
  // Sunshine starts (or resumes) an app for every stream; the next poll
  // confirms it, but until then the PC is already busy.
  sunshineBusy = true;
}

export function streamEnded(socket: object): void {
  streaming.delete(socket);
}

/** For the PC card: who has it, from this person's point of view. */
export function status(user: StreamUser | null) {
  const current = [...streaming.values()][0] ?? null;
  const who = current?.user ?? (sunshineBusy ? owner?.user : null) ?? null;
  return {
    busy: sunshineBusy || streaming.size > 0,
    streaming: streaming.size > 0,
    owner: who ? { id: who.id, name: who.name, you: !!user && who.id === user.id } : null,
    canConnect: user ? decide(user).allowed : false,
  };
}
