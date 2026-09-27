import { randomUUID } from "node:crypto";
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
  /** Someone is streaming right now, so they can be asked to hand over. */
  canRequest?: boolean;
  /** Who has the PC, for "X is using this PC". */
  ownerName?: string;
}

/** May this person start or join a stream right now? */
export function decide(user: StreamUser): SessionDecision {
  if (handedOver && handedOver.userId === user.id && Date.now() < handedOver.until) {
    return { allowed: true };
  }
  const other = otherStreamer(user);
  if (other) {
    const ownerName = other.user.name;
    if (user.admin) {
      return {
        allowed: true,
        takeOver: true,
        canRequest: true,
        ownerName,
        reason: `${ownerName} is playing right now. Connecting takes over their session.`,
      };
    }
    return { allowed: false, canRequest: true, ownerName, reason: `${ownerName} is playing on this PC right now.` };
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
  if (handedOver?.userId === user.id) handedOver = null;
  streaming.set(socket, { user, since: Date.now() });
  owner = { user, since: Date.now() };
  // Sunshine starts (or resumes) an app for every stream; the next poll
  // confirms it, but until then the PC is already busy.
  sunshineBusy = true;
}

export function streamEnded(socket: object): void {
  streaming.delete(socket);
}

/** Closing what's running on the PC ("Stop current session") is for whoever
 * it belongs to; others can only ask for a hand-over. Admins still can. */
export function mayStopSession(user: StreamUser): boolean {
  if (user.admin) return true;
  const current = [...streaming.values()][0]?.user ?? (sunshineBusy ? owner?.user : null);
  return !current || current.id === user.id;
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

// --- Hand-over requests: someone who finds the PC in use asks the person
// streaming to hand it over. The streamer sees a notification with a
// countdown; it lapses on its own after REQUEST_MS.

const REQUEST_MS = 10_000;
/** How long a handed-over PC waits for its new player to connect. */
const HANDOVER_GRACE_MS = 60_000;
/** Answered requests are kept this long so the asker can read the result. */
const KEEP_MS = 60_000;
/** Lets the handed-over stream finish its goodbye before it's closed. */
const CLOSE_DELAY_MS = 1500;

type RequestState = "pending" | "accepted" | "declined" | "expired" | "cancelled";

interface HandoverRequest {
  id: string;
  from: StreamUser;
  to: StreamUser;
  expiresAt: number;
  state: RequestState;
  answeredAt: number;
}

const requests = new Map<string, HandoverRequest>();

/** Who was handed the PC and may connect past the lock until when. */
let handedOver: { userId: number; until: number } | null = null;

function refresh(now = Date.now()): void {
  for (const [id, r] of requests) {
    if (r.state === "pending" && now >= r.expiresAt) {
      r.state = "expired";
      r.answeredAt = r.expiresAt;
    }
    if (r.state !== "pending" && now - r.answeredAt > KEEP_MS) requests.delete(id);
  }
}

export interface RequestView {
  id: string;
  state: RequestState;
  from: string;
  to: string;
  /** Milliseconds left before it lapses (0 once answered). */
  remainingMs: number;
  timeoutMs: number;
}

function view(r: HandoverRequest): RequestView {
  return {
    id: r.id,
    state: r.state,
    from: r.from.name,
    to: r.to.name,
    remainingMs: r.state === "pending" ? Math.max(0, r.expiresAt - Date.now()) : 0,
    timeoutMs: REQUEST_MS,
  };
}

/** Ask whoever is streaming to hand the PC over. Replaces this person's
 * earlier request, so asking again restarts the countdown. */
export function requestHandover(user: StreamUser): RequestView | { error: string } {
  refresh();
  const other = otherStreamer(user);
  if (!other) return { error: "Nobody is streaming on this PC right now, so there's no one to ask." };
  for (const r of requests.values()) {
    if (r.from.id === user.id && r.state === "pending") {
      r.state = "cancelled";
      r.answeredAt = Date.now();
    }
  }
  const request: HandoverRequest = {
    id: randomUUID(),
    from: user,
    to: other.user,
    expiresAt: Date.now() + REQUEST_MS,
    state: "pending",
    answeredAt: 0,
  };
  requests.set(request.id, request);
  return view(request);
}

/** The asker checking on their request. */
export function getRequest(id: string, user: StreamUser): RequestView | null {
  refresh();
  const r = requests.get(id);
  return r && r.from.id === user.id ? view(r) : null;
}

export function cancelRequest(id: string, user: StreamUser): void {
  const r = requests.get(id);
  if (r && r.from.id === user.id && r.state === "pending") {
    r.state = "cancelled";
    r.answeredAt = Date.now();
  }
}

/** Requests waiting on this person (the one streaming). */
export function inbox(user: StreamUser): RequestView[] {
  refresh();
  return [...requests.values()].filter((r) => r.to.id === user.id && r.state === "pending").map(view);
}

/** The streamer's answer. Handing over lets the asker past the lock and
 * ends the streamer's own stream. */
export function answerRequest(id: string, user: StreamUser, accept: boolean): RequestView | { error: string } {
  refresh();
  const r = requests.get(id);
  if (!r || r.to.id !== user.id) return { error: "That request isn't for you." };
  if (r.state !== "pending") return { error: r.state === "expired" ? "That request already timed out." : "That request was already answered." };
  r.state = accept ? "accepted" : "declined";
  r.answeredAt = Date.now();
  if (accept) {
    handedOver = { userId: r.from.id, until: Date.now() + HANDOVER_GRACE_MS };
    owner = { user: r.from, since: Date.now() };
    // Any other request for this PC is moot now.
    for (const other of requests.values()) {
      if (other !== r && other.to.id === user.id && other.state === "pending") {
        other.state = "declined";
        other.answeredAt = Date.now();
      }
    }
    const reason = `Handed over to ${r.from.name}`;
    setTimeout(() => {
      for (const [socket, s] of streaming) {
        if (s.user.id !== user.id) continue;
        streaming.delete(socket);
        try {
          (socket as { close(code: number, reason: string): void }).close(4010, reason);
        } catch {
          // already gone
        }
      }
    }, CLOSE_DELAY_MS).unref();
  }
  return view(r);
}