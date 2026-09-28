import { randomUUID } from "node:crypto";
import type { StreamUser } from "./streamUser.js";

// One Sunshine host means one desktop: everyone who connects sees the same
// screen. So the PC belongs to whoever started what's running on it until
// it's closed; others can't connect into their game (admins can take over).
// Every moonlight-web-stream "device" here is the same Sunshine, so the
// lock is for the whole PC, not per host id.
//
// The lock doesn't last forever: a game left open with nobody connected is
// released after a while (sooner when someone is waiting), and a player
// who's been away from their controls hands over as soon as someone asks.
// People who find the PC in use can wait in line; the first in line gets
// the PC held for them once it's free.

const SUNSHINE_SERVERINFO = "http://127.0.0.1:47989/serverinfo";
const POLL_MS = 4000;

/** A game left open with nobody streaming stops being theirs after this. */
export const ABANDON_MS = 10 * 60_000;
/** ...or after this, when someone is waiting in line. */
export const ABANDON_QUEUED_MS = 3 * 60_000;
/** A player with no input for this long hands over as soon as someone asks. */
export const IDLE_MS = 15 * 60_000;
/** Activity reports older than this say nothing about the player now. */
const ACTIVITY_FRESH_MS = 2 * 60_000;
/** A place in line lapses when its page stops checking in for this long. */
const QUEUE_STALE_MS = 30_000;
/** How long the PC is held for whoever is next in line. */
export const QUEUE_TURN_MS = 90_000;

interface Streamer {
  user: StreamUser;
  since: number;
}

/** Open stream WebSockets (their client-side socket) -> who. */
const streaming = new Map<object, Streamer>();

/** Who started what's running on the PC; cleared once Sunshine is free.
 * lastSeen = when they last had a stream open. */
let owner: { user: StreamUser; since: number; lastSeen: number } | null = null;
let sunshineBusy = false;

/** Latest "ms since my last input" report from each streamer's page. */
const activity = new Map<number, { idleMs: number; at: number }>();

interface QueueEntry {
  user: StreamUser;
  joinedAt: number;
  lastPoll: number;
}
let queue: QueueEntry[] = [];

/** Who the PC is held for (hand-over or their turn in line), until when. */
let reserved: { user: StreamUser; until: number; via: "handover" | "queue" } | null = null;

async function pollSunshine(): Promise<void> {
  try {
    const res = await fetch(SUNSHINE_SERVERINFO, { signal: AbortSignal.timeout(3000) });
    const text = await res.text();
    setSunshineBusy(/<state>SUNSHINE_SERVER_BUSY<\/state>/.test(text));
  } catch {
    // Sunshine restarting: keep the last known state
  }
}

/** Sunshine's state as last polled (exported for tests). */
export function setSunshineBusy(busy: boolean): void {
  sunshineBusy = busy;
  if (streaming.size > 0 && owner) owner.lastSeen = Date.now();
  if (!sunshineBusy && streaming.size === 0) owner = null;
  advanceQueue();
}

if (process.env.NODE_ENV !== "test") {
  setInterval(() => void pollSunshine(), POLL_MS).unref();
  void pollSunshine();
}

function otherStreamer(user: StreamUser): Streamer | null {
  for (const s of streaming.values()) if (s.user.id !== user.id) return s;
  return null;
}

function ownerIsStreaming(): boolean {
  if (!owner) return false;
  for (const s of streaming.values()) if (s.user.id === owner.user.id) return true;
  return false;
}

/** Their game is open and still theirs: they're streaming, or haven't been
 * gone long enough for it to lapse. */
function ownerHolds(now = Date.now()): boolean {
  if (!owner || !sunshineBusy) return false;
  if (ownerIsStreaming()) return true;
  const limit = queue.length > 0 ? ABANDON_QUEUED_MS : ABANDON_MS;
  return now - owner.lastSeen < limit;
}

function reservationFor(now = Date.now()) {
  if (reserved && now >= reserved.until) reserved = null;
  return reserved;
}

/** Nobody is streaming and nobody's game is holding the PC. */
function pcFree(now = Date.now()): boolean {
  return streaming.size === 0 && !ownerHolds(now);
}

/** Drop places in line whose page went away, and once the PC is free,
 * hold it for whoever is first. */
function advanceQueue(now = Date.now()): void {
  queue = queue.filter((q) => now - q.lastPoll < QUEUE_STALE_MS);
  if (queue.length === 0 || reservationFor(now) || !pcFree(now)) return;
  const next = queue.shift()!;
  reserved = { user: next.user, until: now + QUEUE_TURN_MS, via: "queue" };
}

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return `${m} minute${m === 1 ? "" : "s"}`;
}

export interface SessionDecision {
  allowed: boolean;
  /** Plain-language reason when not allowed, or a heads-up when it is. */
  reason?: string;
  takeOver?: boolean;
  /** Someone is streaming right now, so they can be asked to hand over. */
  canRequest?: boolean;
  /** The PC is in use, so they can wait in line for it. */
  canQueue?: boolean;
  /** Who has the PC, for "X is using this PC". */
  ownerName?: string;
  /** Joining someone's game as player 2 (their co-op invite). */
  guest?: boolean;
  inviteId?: string;
}

/** May this person start or join a stream right now? */
export function decide(user: StreamUser): SessionDecision {
  const now = Date.now();
  advanceQueue(now);
  const invite = activeInviteFor(user, now);
  if (invite) return { allowed: true, guest: true, ownerName: invite.from.name, inviteId: invite.id };
  const held = reservationFor(now);
  if (held && held.user.id === user.id) return { allowed: true };

  const other = otherStreamer(user);
  if (other) {
    const ownerName = other.user.name;
    if (user.admin) {
      return {
        allowed: true,
        takeOver: true,
        canRequest: true,
        canQueue: true,
        ownerName,
        reason: `${ownerName} is playing right now. Connecting takes over their session.`,
      };
    }
    return { allowed: false, canRequest: true, canQueue: true, ownerName, reason: `${ownerName} is playing on this PC right now.` };
  }

  if (owner && owner.user.id !== user.id && sunshineBusy) {
    const ownerName = owner.user.name;
    if (ownerHolds(now)) {
      const limit = queue.length > 0 ? ABANDON_QUEUED_MS : ABANDON_MS;
      const left = limit - (now - owner.lastSeen);
      if (user.admin) {
        return { allowed: true, takeOver: true, canQueue: true, ownerName, reason: `${ownerName}'s game is still open on this PC. Connecting takes it over.` };
      }
      return {
        allowed: false,
        canQueue: true,
        ownerName,
        reason: `${ownerName}'s game is still open on this PC. It's freed up in ${minutes(left)} if they don't come back, or wait in line to be let in as soon as it is.`,
      };
    }
    // Left open and not come back for: anyone may have it.
    if (!held) {
      return {
        allowed: true,
        takeOver: true,
        ownerName,
        reason: `${ownerName} left their game open ${minutes(now - owner.lastSeen)} ago. Connecting takes it over.`,
      };
    }
  }

  if (held) {
    const turn = held.via === "queue" ? "It's their turn in line" : "They were handed the PC";
    if (user.admin) {
      return { allowed: true, takeOver: true, ownerName: held.user.name, reason: `The PC is being held for ${held.user.name}. Connecting takes it instead.` };
    }
    return {
      allowed: false,
      canQueue: true,
      ownerName: held.user.name,
      reason: `The PC is being held for ${held.user.name}. ${turn}, and they have ${Math.ceil((held.until - now) / 1000)} seconds to connect.`,
    };
  }
  return { allowed: true };
}

/** The stream's Init message got through: this person has the PC now, or,
 * with a co-op invite, is watching and playing along as player 2. */
export function streamStarted(socket: object, user: StreamUser): "owner" | "guest" {
  const invite = activeInviteFor(user);
  if (invite) {
    invite.state = "joined";
    guests.set(socket, { user, inviteId: invite.id });
    return "guest";
  }
  if (reserved?.user.id === user.id) reserved = null;
  queue = queue.filter((q) => q.user.id !== user.id);
  // Someone else has the PC now: the old player's co-op is over.
  if (owner && owner.user.id !== user.id) endInvitesFrom(owner.user.id, `${user.name} took over the PC`);
  streaming.set(socket, { user, since: Date.now() });
  owner = { user, since: Date.now(), lastSeen: Date.now() };
  // Sunshine starts (or resumes) an app for every stream; the next poll
  // confirms it, but until then the PC is already busy.
  sunshineBusy = true;
  return "owner";
}

export function streamEnded(socket: object): void {
  if (guests.delete(socket)) return;
  const s = streaming.get(socket);
  streaming.delete(socket);
  if (s && owner?.user.id === s.user.id) owner.lastSeen = Date.now();
  advanceQueue();
}

/** Whose game it is, if it's still theirs. */
function currentHolder(): StreamUser | null {
  return [...streaming.values()][0]?.user ?? (ownerHolds() ? owner!.user : null);
}

/** Who the game about to start on the PC is for: whoever most recently got
 * a stream through (per-player saves, host/profiles.ps1). */
export function currentPlayer(): StreamUser | null {
  return owner?.user ?? null;
}

/** Closing what's running on the PC ("Stop current session") is for whoever
 * it belongs to; others can only ask for a hand-over. Admins still can, and
 * anyone can close a game its player abandoned. */
export function mayStopSession(user: StreamUser): boolean {
  if (user.admin) return true;
  const current = currentHolder();
  return !current || current.id === user.id;
}

/** For the PC card: who has it, from this person's point of view. */
export function status(user: StreamUser | null) {
  const now = Date.now();
  advanceQueue(now);
  const who = currentHolder() ?? (sunshineBusy ? owner?.user : null) ?? null;
  const position = user ? queue.findIndex((q) => q.user.id === user.id) : -1;
  const held = reservationFor(now);
  return {
    /** Playing along as player 2+ right now. */
    guests: [...new Set([...guests.values()].filter((g) => guestRole(g) === "player2").map((g) => g.user.name))],
    /** Watching without a controller. */
    spectators: [...new Set([...guests.values()].filter((g) => guestRole(g) === "spectator").map((g) => g.user.name))],
    busy: sunshineBusy || streaming.size > 0,
    streaming: streaming.size > 0,
    owner: who ? { id: who.id, name: who.name, you: !!user && who.id === user.id } : null,
    /** Left open by someone who hasn't come back: anyone may take it. */
    abandoned: !!owner && sunshineBusy && !ownerHolds(now),
    waiting: queue.length,
    heldFor: held ? { name: held.user.name, you: !!user && held.user.id === user.id } : null,
    queuePosition: position >= 0 ? position + 1 : null,
    canConnect: user ? decide(user).allowed : false,
  };
}

// --- Activity: the stream page reports how long since the player last
// touched anything. Nothing is ended for being idle alone; it only means a
// hand-over request doesn't have to wait for an answer.

export function recordActivity(user: StreamUser, idleMs: number): void {
  if (!Number.isFinite(idleMs) || idleMs < 0) return;
  activity.set(user.id, { idleMs, at: Date.now() });
  if (owner?.user.id === user.id && ownerIsStreaming()) owner.lastSeen = Date.now();
}

/** How long this person has been away from their controls, if known. */
function idleFor(userId: number, now = Date.now()): number | null {
  const a = activity.get(userId);
  if (!a || now - a.at > ACTIVITY_FRESH_MS) return null;
  return a.idleMs + (now - a.at);
}

// --- Waiting in line

export interface QueueView {
  position: number | null;
  waiting: number;
  /** The PC is held for you now: connect before heldUntilMs runs out. */
  yourTurn: boolean;
  remainingMs: number;
  ownerName: string | null;
  /** The player invited you to join or watch while you wait. */
  invite: InviteView | null;
  /** Taken out of the line by the player or an admin: why. */
  removed: string | null;
}

/** People taken out of the line can't rejoin it for this long. */
const REMOVED_MS = 5 * 60_000;
const removed = new Map<number, { reason: string; until: number }>();

function removedReason(userId: number, now = Date.now()): string | null {
  const r = removed.get(userId);
  if (!r) return null;
  if (now >= r.until) {
    removed.delete(userId);
    return null;
  }
  return r.reason;
}

function queueView(user: StreamUser, now = Date.now()): QueueView {
  advanceQueue(now);
  const held = reservationFor(now);
  const position = queue.findIndex((q) => q.user.id === user.id);
  const yourTurn = !!held && held.user.id === user.id;
  return {
    position: position >= 0 ? position + 1 : null,
    waiting: queue.length,
    yourTurn,
    remainingMs: yourTurn ? held.until - now : 0,
    ownerName: currentHolder()?.name ?? null,
    invite: openInviteFor(user, now),
    removed: position < 0 && !yourTurn ? removedReason(user.id, now) : null,
  };
}

/** Join the line (or stay in it: the waiting page calls this to check in). */
export function joinQueue(user: StreamUser): QueueView | { error: string } {
  const now = Date.now();
  advanceQueue(now);
  const held = reservationFor(now);
  if (held?.user.id === user.id) return queueView(user, now);
  const mine = queue.find((q) => q.user.id === user.id);
  if (mine) {
    mine.lastPoll = now;
    return queueView(user, now);
  }
  if (pcFree(now) && !held) return { error: "The PC is free - you can connect now." };
  const out = removedReason(user.id, now);
  if (out) return { error: out };
  queue.push({ user, joinedAt: now, lastPoll: now });
  return queueView(user, now);
}

/** Checking on your place in line, which also keeps it. */
export function checkQueue(user: StreamUser): QueueView {
  const now = Date.now();
  const mine = queue.find((q) => q.user.id === user.id);
  if (mine) mine.lastPoll = now;
  return queueView(user, now);
}

export function leaveQueue(user: StreamUser): void {
  queue = queue.filter((q) => q.user.id !== user.id);
  if (reserved?.user.id === user.id) reserved = null;
  advanceQueue();
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

/** Join requests (to play along or watch) wait this long: the player may
 * be mid-game and has to open the panel to answer. */
const JOIN_REQUEST_MS = 30_000;

type RequestState = "pending" | "accepted" | "declined" | "expired" | "cancelled";

/** What someone connecting asks the player for: the PC itself, to join as
 * player 2, or to watch. */
export type RequestKind = "handover" | "player2" | "spectate";

interface HandoverRequest {
  id: string;
  kind: RequestKind;
  from: StreamUser;
  to: StreamUser;
  expiresAt: number;
  state: RequestState;
  answeredAt: number;
  /** Accepted by itself because the player was away. */
  auto: boolean;
  /** What the player gave them (may differ from what they asked for). */
  granted?: RequestKind;
  /** The co-op invite made for them when let in to play or watch. */
  inviteId?: string;
}

const requests = new Map<string, HandoverRequest>();

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
  kind: RequestKind;
  granted?: RequestKind;
  /** Let in to play along or watch: the stream to join with. */
  invite?: InviteView;
  state: RequestState;
  from: string;
  to: string;
  /** Milliseconds left before it lapses (0 once answered). */
  remainingMs: number;
  timeoutMs: number;
  /** Handed over without asking, because the player was away. */
  auto?: boolean;
}

function view(r: HandoverRequest): RequestView {
  const invite = r.inviteId ? invites.get(r.inviteId) : undefined;
  return {
    id: r.id,
    kind: r.kind,
    granted: r.granted,
    invite: invite ? inviteView(invite) : undefined,
    state: r.state,
    from: r.from.name,
    to: r.to.name,
    remainingMs: r.state === "pending" ? Math.max(0, r.expiresAt - Date.now()) : 0,
    timeoutMs: requestMs(r.kind),
    auto: r.auto || undefined,
  };
}

function requestMs(kind: RequestKind): number {
  return kind === "handover" ? REQUEST_MS : JOIN_REQUEST_MS;
}

/** Ask whoever is streaming to hand the PC over, or to let you join as
 * player 2 or watch. Replaces this person's earlier request, so asking
 * again restarts the countdown. A player who's been away from their
 * controls for IDLE_MS hands over straight away. */
export function requestHandover(user: StreamUser, kind: RequestKind = "handover"): RequestView | { error: string } {
  refresh();
  const other = otherStreamer(user);
  if (!other) return { error: "Nobody is streaming on this PC right now, so there's no one to ask." };
  if (kind !== "handover" && owner?.user.id !== other.user.id) {
    return { error: `${other.user.name} isn't playing their own game, so they can't let you join.` };
  }
  if (kind === "player2") {
    const full = gameFull(other.user.id, user.id);
    if (full) return { error: full };
  }
  for (const r of requests.values()) {
    if (r.from.id === user.id && r.state === "pending") {
      r.state = "cancelled";
      r.answeredAt = Date.now();
    }
  }
  const request: HandoverRequest = {
    id: randomUUID(),
    kind,
    from: user,
    to: other.user,
    expiresAt: Date.now() + requestMs(kind),
    state: "pending",
    answeredAt: 0,
    auto: false,
  };
  requests.set(request.id, request);
  const idle = idleFor(other.user.id);
  if (kind === "handover" && idle !== null && idle >= IDLE_MS) {
    request.auto = true;
    accept(request, `Handed over to ${user.name} - you were away for ${minutes(idle)}`);
  }
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

/** Requests waiting on this person (the one streaming), and who is waiting
 * in line behind them. */
export function inbox(user: StreamUser): { requests: RequestView[]; waiting: string[] } {
  refresh();
  advanceQueue();
  const mine = currentHolder()?.id === user.id;
  return {
    requests: [...requests.values()].filter((r) => r.to.id === user.id && r.state === "pending").map(view),
    waiting: mine ? queue.map((q) => q.user.name) : [],
  };
}

/** The streamer's answer (or an admin's). Handing over lets the asker past
 * the lock and ends the streamer's own stream; letting them play along or
 * watch makes them a co-op invite that's already accepted. `grant` gives
 * something other than what they asked for; `stream` is what a co-op guest
 * joins with (the player's page knows it; otherwise its last report). */
export function answerRequest(
  id: string,
  user: StreamUser,
  yes: boolean,
  grant?: RequestKind,
  stream?: CoopStream | null
): RequestView | { error: string } {
  refresh();
  const r = requests.get(id);
  if (!r || (r.to.id !== user.id && !user.admin)) return { error: "That request isn't for you." };
  if (r.state !== "pending") return { error: r.state === "expired" ? "That request already timed out." : "That request was already answered." };
  if (!yes) {
    r.state = "declined";
    r.answeredAt = Date.now();
    return view(r);
  }
  const give = grant ?? r.kind;
  if (give === "handover") {
    accept(r, `Handed over to ${r.from.name}`);
    return view(r);
  }
  const invite = makeInvite(r.to, r.from, give === "spectate" ? "spectator" : "player2", stream, "accepted");
  if ("error" in invite) return invite;
  r.state = "accepted";
  r.answeredAt = Date.now();
  r.granted = give;
  r.inviteId = invite.id;
  return view(r);
}

function accept(r: HandoverRequest, reason: string): void {
  r.state = "accepted";
  r.answeredAt = Date.now();
  r.granted = "handover";
  giveTo(r.from, r.to.id, reason);
}

/** The PC goes to `to`: held for them to connect, and the stream of
 * whoever had it (`fromId`) is closed in a moment. */
function giveTo(to: StreamUser, fromId: number, reason: string): void {
  const fromName = owner?.user.id === fromId ? owner.user.name : "The player";
  endInvitesFrom(fromId, `${fromName} handed the PC over`);
  reserved = { user: to, until: Date.now() + HANDOVER_GRACE_MS, via: "handover" };
  owner = { user: to, since: Date.now(), lastSeen: Date.now() };
  queue = queue.filter((q) => q.user.id !== to.id);
  // Any other request for this PC is moot now.
  for (const other of requests.values()) {
    if (other.to.id === fromId && other.state === "pending") {
      other.state = "declined";
      other.answeredAt = Date.now();
    }
  }
  const handedOverBy = fromId;
  setTimeout(() => {
    for (const [socket, s] of streaming) {
      if (s.user.id !== handedOverBy) continue;
      streaming.delete(socket);
      try {
        (socket as { close(code: number, reason: string): void }).close(4010, reason.slice(0, 120));
      } catch {
        // already gone
      }
    }
  }, CLOSE_DELAY_MS).unref();
}

// --- Co-op: the person streaming invites someone to join their game as
// player 2. Sunshine streams the same screen to both (sunshine.conf
// channels >= 2); each browser's controllers become the next free pads, so
// the guest's pad is player 2. Guests never own the PC: they don't count
// for the lock, can't close the game or go Home, and leave when the player
// ends co-op, hands the PC over or someone takes it.

/** An unanswered invite lapses after this. */
const INVITE_MS = 10 * 60_000;

/** What the guest's stream asks the host for: the player's exact size and
 * frame rate, so Sunshine never resizes the screen under them. */
export interface CoopStream {
  hostId: number;
  appId: number;
  width: number;
  height: number;
  fps: number;
}

type InviteState = "pending" | "accepted" | "joined" | "declined" | "ended";

/** Player 2 plays along with a controller; a spectator only watches. */
export type GuestRole = "player2" | "spectator";

interface Invite {
  id: string;
  from: StreamUser;
  to: StreamUser;
  stream: CoopStream;
  role: GuestRole;
  /** Players' seat in the game, 1-3 (seat 0 is the person playing): which
   * block of controller numbers their browser uses on the PC. Spectators
   * have none. */
  seat: number | null;
  state: InviteState;
  expiresAt: number;
}

const invites = new Map<string, Invite>();
/** Guests' stream sockets -> who, and which invite let them in. */
const guests = new Map<object, { user: StreamUser; inviteId: string }>();

function isStreaming(userId: number): boolean {
  for (const s of streaming.values()) if (s.user.id === userId) return true;
  return false;
}

function inviteLive(i: Invite, now = Date.now()): boolean {
  if (i.state === "declined" || i.state === "ended") return false;
  if (i.state === "pending" && now >= i.expiresAt) return false;
  // The player's game has to still be theirs.
  return owner?.user.id === i.from.id && (isStreaming(i.from.id) || ownerHolds(now));
}

/** The invite that lets this person join as a guest right now, if any:
 * accepted (or already joined) and its player still has the PC. */
function activeInviteFor(user: StreamUser, now = Date.now()): Invite | null {
  for (const i of invites.values()) {
    if (i.to.id === user.id && (i.state === "accepted" || i.state === "joined") && inviteLive(i, now)) return i;
  }
  return null;
}

export interface InviteView {
  id: string;
  from: string;
  to: string;
  state: InviteState;
  role: GuestRole;
  seat: number | null;
  stream: CoopStream;
}

function inviteView(i: Invite): InviteView {
  return { id: i.id, from: i.from.name, to: i.to.name, state: i.state, role: i.role, seat: i.seat, stream: i.stream };
}

function guestRole(g: { inviteId: string }): GuestRole {
  return invites.get(g.inviteId)?.role ?? "player2";
}

/** A live invite for this person that they haven't joined with yet. */
function openInviteFor(user: StreamUser, now = Date.now()): InviteView | null {
  for (const i of invites.values()) {
    if (i.to.id === user.id && (i.state === "pending" || i.state === "accepted") && inviteLive(i, now)) return inviteView(i);
  }
  return null;
}

function closeGuests(inviteIds: Set<string>, reason: string): void {
  for (const [socket, g] of guests) {
    if (!inviteIds.has(g.inviteId)) continue;
    guests.delete(socket);
    try {
      (socket as { close(code: number, reason: string): void }).close(4011, reason.slice(0, 120));
    } catch {
      // already gone
    }
  }
}

export function endInvitesFrom(userId: number, reason: string): void {
  const ended = new Set<string>();
  for (const i of invites.values()) {
    if (i.from.id === userId && i.state !== "ended" && i.state !== "declined") {
      i.state = "ended";
      ended.add(i.id);
    }
  }
  if (ended.size) closeGuests(ended, reason);
}

/** Invites to this person end: they're out of their co-op games. */
export function endInvitesTo(userId: number, reason: string): void {
  const ended = new Set<string>();
  for (const i of invites.values()) {
    if (i.to.id === userId && i.state !== "ended" && i.state !== "declined") {
      i.state = "ended";
      ended.add(i.id);
    }
  }
  if (ended.size) closeGuests(ended, reason);
}

/** The player invites someone to play along (or watch). Asking the same
 * person again replaces their earlier invite. */
export function createInvite(from: StreamUser, to: StreamUser, stream: CoopStream, role: GuestRole = "player2"): InviteView | { error: string } {
  return makeInvite(from, to, role, stream, "pending");
}

function makeInvite(
  from: StreamUser,
  to: StreamUser,
  role: GuestRole,
  stream: CoopStream | null | undefined,
  state: "pending" | "accepted"
): InviteView | { error: string } {
  if (to.id === from.id) return { error: "You can't invite yourself." };
  if (!isStreaming(from.id) || owner?.user.id !== from.id) return { error: "Only the person playing can invite someone." };
  const shared = stream ?? latestStreams.get(from.id);
  if (!shared) return { error: `${from.name}'s stream hasn't reported its size yet - try again in a few seconds.` };
  for (const i of invites.values()) {
    if (i.from.id === from.id && i.to.id === to.id && (i.state === "pending" || i.state === "accepted")) i.state = "ended";
  }
  let seat: number | null = null;
  if (role === "player2") {
    const full = gameFull(from.id, to.id);
    if (full) return { error: full };
    seat = freeSeat(from.id);
  }
  const invite: Invite = { id: randomUUID(), from, to, stream: shared, role, seat, state, expiresAt: Date.now() + INVITE_MS };
  invites.set(invite.id, invite);
  // Joining the game is their way in now, not their place in line.
  queue = queue.filter((q) => q.user.id !== to.id);
  return inviteView(invite);
}

/** Invites waiting for this person to answer. */
export function invitesFor(user: StreamUser): InviteView[] {
  const now = Date.now();
  return [...invites.values()].filter((i) => i.to.id === user.id && i.state === "pending" && inviteLive(i, now)).map(inviteView);
}

/** The player's view of their co-op: who's invited and who's in. */
export function invitesFrom(user: StreamUser): InviteView[] {
  const now = Date.now();
  return [...invites.values()].filter((i) => i.from.id === user.id && inviteLive(i, now)).map(inviteView);
}

export function answerInvite(id: string, user: StreamUser, yes: boolean): InviteView | { error: string } {
  const i = invites.get(id);
  if (!i || i.to.id !== user.id) return { error: "That invite isn't for you." };
  if (!inviteLive(i) || (i.state !== "pending" && i.state !== "accepted")) return { error: `${i.from.name} isn't playing any more.` };
  i.state = yes ? "accepted" : "declined";
  return inviteView(i);
}

/** Either side ends it: the player (kicking the guest) or the guest. */
export function endInvite(id: string, user: StreamUser): { ok: true } | { error: string } {
  const i = invites.get(id);
  if (!i || (i.from.id !== user.id && i.to.id !== user.id && !user.admin)) return { error: "No such invite." };
  i.state = "ended";
  closeGuests(new Set([i.id]), i.from.id === user.id ? `${i.from.name} ended co-op` : "Co-op ended");
  return { ok: true };
}

/** Each player's current stream, from their page's 30 s report: what a
 * player-2 guest link joins with (routes/guestLinks.ts). */
const latestStreams = new Map<number, CoopStream>();

export function recordStream(user: StreamUser, stream: CoopStream): void {
  latestStreams.set(user.id, stream);
}

/** The stream to join this person's game with, if they're playing now. */
export function joinableStream(userId: number): CoopStream | null {
  if (!isStreaming(userId) || owner?.user.id !== userId) return null;
  return latestStreams.get(userId) ?? null;
}

/** Everyone streaming right now, as the player or as a co-op guest. */
export function playingUserIds(): Set<number> {
  return new Set([...[...streaming.values()].map((s) => s.user.id), ...[...guests.values()].map((g) => g.user.id)]);
}

/** This person's part in someone else's game, if they're a guest. */
export function guestRoleOf(user: StreamUser): GuestRole | null {
  return activeInviteFor(user)?.role ?? null;
}

/** Guests may play, but not close the game, go Home or switch windows. */
export function isGuest(user: StreamUser): boolean {
  return !!activeInviteFor(user) && owner?.user.id !== user.id;
}

/** The app a guest must stream: their invite's. */
export function guestStream(user: StreamUser): CoopStream | null {
  return activeInviteFor(user)?.stream ?? null;
}

// --- Seats and controllers. Sunshine numbers controllers across every
// stream to the PC, so each browser gets its own block of numbers: the
// person playing 0-3, and each guest who plays a seat with the next block
// (seat n: 4n to 4n+3). Windows has four Xbox controller slots, so the game
// takes four controllers at most, however many people bring them.

export const MAX_CONTROLLERS = 4;
const CONTROLLER_BLOCK = 4;
/** Controller counts older than this say nothing about now. */
const PADS_FRESH_MS = 15_000;
/** since: when their first controller joined (Windows numbers controllers
 * in the order they arrive). */
const padCounts = new Map<number, { count: number; at: number; since: number }>();

/** A page's report of how many controllers it has joined to the game. */
export function recordPads(user: StreamUser, count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > 16) return;
  const now = Date.now();
  const before = padCounts.get(user.id);
  const since = before && before.count > 0 && now - before.at < PADS_FRESH_MS ? before.since : now;
  padCounts.set(user.id, { count, at: now, since });
}

function padsOf(userId: number, now = Date.now()): number {
  const p = padCounts.get(userId);
  return p && now - p.at < PADS_FRESH_MS ? p.count : 0;
}

/** Guests playing along in this person's game, by seat. */
function seatedInvites(fromId: number, now = Date.now()): Invite[] {
  return [...invites.values()]
    .filter((i) => i.from.id === fromId && i.role === "player2" && i.seat !== null && inviteLive(i, now))
    .sort((a, b) => a.seat! - b.seat!);
}

function freeSeat(fromId: number, now = Date.now()): number | null {
  const taken = new Set(seatedInvites(fromId, now).map((i) => i.seat));
  for (let seat = 1; seat < MAX_CONTROLLERS; seat++) if (!taken.has(seat)) return seat;
  return null;
}

/** Controllers in this person's game right now, leaving out one person's. */
function padsInGame(fromId: number, exceptUserId: number | null = null, now = Date.now()): number {
  let total = fromId === exceptUserId ? 0 : padsOf(fromId, now);
  for (const i of seatedInvites(fromId, now)) if (i.to.id !== exceptUserId) total += padsOf(i.to.id, now);
  return total;
}

/** Why someone can't join this game as a player, if they can't. */
function gameFull(fromId: number, joinerId: number, now = Date.now()): string | null {
  const alreadySeated = seatedInvites(fromId, now).some((i) => i.to.id === joinerId);
  if (!alreadySeated && freeSeat(fromId, now) === null) {
    return `The game is full - ${MAX_CONTROLLERS} players are in. You can watch instead.`;
  }
  if (padsInGame(fromId, joinerId, now) >= MAX_CONTROLLERS) {
    return `The game is full - ${MAX_CONTROLLERS} controllers are connected. You can watch instead.`;
  }
  return null;
}

/** Player numbers as the game sees them: each person's controllers in the
 * order their first one joined, as Windows hands out controller slots. */
function playerNumbers(now = Date.now()): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const player = owner && isStreaming(owner.user.id) ? owner.user : null;
  if (!player) return out;
  const inGame = [player.id, ...seatedInvites(player.id, now).filter((i) => i.state === "joined").map((i) => i.to.id)]
    .filter((id) => padsOf(id, now) > 0)
    .sort((a, b) => padCounts.get(a)!.since - padCounts.get(b)!.since);
  let next = 1;
  for (const id of inGame) {
    const numbers: number[] = [];
    for (let k = 0; k < padsOf(id, now) && next <= MAX_CONTROLLERS; k++) numbers.push(next++);
    out.set(id, numbers);
  }
  return out;
}

// --- The people panel: everyone connected to the PC and what they're doing,
// and what the player (or an admin) can do about each of them: let them
// play along or just watch, offer them the PC, or send them away.

function socketClose(socket: object, code: number, reason: string): void {
  try {
    (socket as { close(code: number, reason: string): void }).close(code, reason.slice(0, 120));
  } catch {
    // already gone
  }
}

/** An offer of the PC to a guest, who takes it or not. */
const OFFER_MS = 30_000;

interface Offer {
  id: string;
  from: StreamUser;
  to: StreamUser;
  expiresAt: number;
}

const offers = new Map<string, Offer>();

export interface OfferView {
  id: string;
  from: string;
  remainingMs: number;
  timeoutMs: number;
}

function liveOffers(now = Date.now()): Offer[] {
  for (const [id, o] of offers) {
    // Lapsed, or whoever made it doesn't have the PC any more.
    if (now >= o.expiresAt || owner?.user.id !== o.from.id) offers.delete(id);
  }
  return [...offers.values()];
}

export type PersonStatus = "playing" | "away" | "player2" | "spectator" | "invited" | "asking" | "waiting" | "held";

export interface Person {
  id: number;
  name: string;
  status: PersonStatus;
  you: boolean;
  /** invited: what as. */
  role?: GuestRole;
  /** asking: what for, and how long the request has left. */
  kind?: RequestKind;
  remainingMs?: number;
  /** waiting: place in line. */
  position?: number;
  /** How long since they touched their controls, when known. */
  idleMs?: number;
  /** Has an offer of the PC waiting. */
  offered?: boolean;
  /** In the game: the player numbers their controllers are (empty until
   * they press a button on one). */
  players?: number[];
}

export interface PeopleView {
  people: Person[];
  /** May change who's in: the player, or an admin. */
  canManage: boolean;
  /** This person's own part. */
  you: {
    status: PersonStatus | null;
    role: GuestRole | null;
    /** Where this browser's controller numbers start on the PC. */
    slotBase: number;
    /** How many controllers this browser may join to the game. */
    padLimit: number;
  };
  /** Offers of the PC waiting on this person. */
  offers: OfferView[];
}

/** Everyone to show, with the StreamUser behind each (for acting on them). */
function roster(now = Date.now()): { person: Omit<Person, "you">; user: StreamUser }[] {
  refresh(now);
  advanceQueue(now);
  const out: { person: Omit<Person, "you">; user: StreamUser }[] = [];
  const seen = new Set<number>();
  const add = (user: StreamUser, person: Omit<Person, "you" | "id" | "name">) => {
    if (seen.has(user.id)) return;
    seen.add(user.id);
    const idle = idleFor(user.id, now);
    out.push({ user, person: { id: user.id, name: user.name, ...person, ...(idle !== null ? { idleMs: idle } : {}) } });
  };
  const offered = new Set(liveOffers(now).map((o) => o.to.id));
  const holder = currentHolder();
  if (holder) add(holder, { status: isStreaming(holder.id) ? "playing" : "away" });
  for (const s of streaming.values()) add(s.user, { status: "playing" });
  for (const g of guests.values()) add(g.user, { status: guestRole(g), ...(offered.has(g.user.id) ? { offered: true } : {}) });
  for (const r of requests.values()) {
    if (r.state === "pending") add(r.from, { status: "asking", kind: r.kind, remainingMs: Math.max(0, r.expiresAt - now) });
  }
  const held = reservationFor(now);
  if (held) add(held.user, { status: "held" });
  queue.forEach((q, i) => add(q.user, { status: "waiting", position: i + 1 }));
  for (const i of invites.values()) {
    if ((i.state === "pending" || i.state === "accepted") && inviteLive(i, now)) add(i.to, { status: "invited", role: i.role });
  }
  const numbers = playerNumbers(now);
  for (const { person } of out) {
    // In the game (playing, or a guest who plays): their player numbers,
    // empty until a controller of theirs joins.
    if (person.status === "playing" || person.status === "player2") person.players = numbers.get(person.id) ?? [];
  }
  return out;
}

function canManage(user: StreamUser): boolean {
  return user.admin || (owner?.user.id === user.id && isStreaming(user.id));
}

/** pads: how many controllers the viewer's page has joined (its report). */
export function people(viewer: StreamUser, pads?: number): PeopleView {
  const now = Date.now();
  if (pads !== undefined) recordPads(viewer, pads);
  const list = roster(now).map(({ person }) => ({ ...person, you: person.id === viewer.id }));
  const me = list.find((p) => p.you);
  const invite = activeInviteFor(viewer, now);
  const game = invite ? invite.from.id : owner?.user.id ?? null;
  const seat = invite?.role === "player2" ? invite.seat ?? 0 : 0;
  const playing = invite ? invite.role === "player2" && invite.seat !== null : owner?.user.id === viewer.id;
  const room = game === null ? MAX_CONTROLLERS : MAX_CONTROLLERS - padsInGame(game, viewer.id, now);
  return {
    people: list,
    canManage: canManage(viewer),
    you: {
      status: me?.status ?? null,
      role: guestRoleOf(viewer),
      slotBase: seat * CONTROLLER_BLOCK,
      padLimit: playing ? Math.max(0, Math.min(CONTROLLER_BLOCK, room)) : 0,
    },
    offers: liveOffers(now)
      .filter((o) => o.to.id === viewer.id)
      .map((o) => ({ id: o.id, from: o.from.name, remainingMs: o.expiresAt - now, timeoutMs: OFFER_MS })),
  };
}

export type PersonAction = "player2" | "spectator" | "handover" | "kick";

/** The player (or an admin) acting on someone in the panel. `stream` is
 * the player's own, for letting someone join (their page sends it). */
export function manage(by: StreamUser, targetId: number, action: PersonAction, stream?: CoopStream | null): { ok: true } | { error: string } {
  if (!canManage(by)) return { error: "Only the person playing (or an admin) can do that." };
  const now = Date.now();
  const entry = roster(now).find((e) => e.user.id === targetId);
  if (!entry) return { error: "They're not connected any more." };
  const { person, user: target } = entry;
  if (target.id === by.id) return { error: "That's you." };
  const player = owner && isStreaming(owner.user.id) ? owner.user : null;
  const myStream = player && by.id === player.id ? stream : null;

  if (action === "kick") return kick(by, target, person.status);

  if (person.status === "playing" || person.status === "away") return { error: `${target.name} has the PC.` };

  if (action === "handover") {
    if (!player) return { error: "Nobody is playing, so there's nothing to hand over." };
    if (person.status === "asking") {
      const r = pendingRequestFrom(target.id);
      if (r) return okOrError(answerRequest(r.id, by, true, "handover", myStream));
    }
    if (person.status === "waiting" || person.status === "held") {
      // They asked for the PC by waiting for it: it's theirs now.
      giveTo(target, player.id, `Handed over to ${target.name}`);
      return { ok: true };
    }
    // A guest (or someone invited) didn't ask: they get an offer to take it.
    for (const [id, o] of offers) if (o.to.id === target.id) offers.delete(id);
    const offer: Offer = { id: randomUUID(), from: player, to: target, expiresAt: now + OFFER_MS };
    offers.set(offer.id, offer);
    return { ok: true };
  }

  // Player 2 or spectator.
  const role: GuestRole = action;
  if (person.status === "player2" || person.status === "spectator" || person.status === "invited") {
    const invite = [...invites.values()].find((i) => i.to.id === target.id && i.state !== "ended" && i.state !== "declined" && inviteLive(i, now));
    if (invite) {
      if (role === "player2" && invite.role !== "player2") {
        const full = gameFull(invite.from.id, target.id, now);
        if (full) return { error: full.replace("You can watch instead.", `${target.name} can keep watching.`) };
        invite.seat = freeSeat(invite.from.id, now);
      }
      if (role === "spectator") invite.seat = null;
      invite.role = role;
      return { ok: true };
    }
  }
  if (!player) return { error: "Nobody is playing, so there's no game to join." };
  if (person.status === "asking") {
    const r = pendingRequestFrom(target.id);
    if (r) return okOrError(answerRequest(r.id, by, true, role === "spectator" ? "spectate" : "player2", myStream));
  }
  // Waiting in line (or held for): an invite they can take up from there.
  return okOrError(makeInvite(player, target, role, myStream, "pending"));
}

function pendingRequestFrom(userId: number): HandoverRequest | null {
  for (const r of requests.values()) if (r.from.id === userId && r.state === "pending") return r;
  return null;
}

function okOrError(result: object): { ok: true } | { error: string } {
  return "error" in result ? (result as { error: string }) : { ok: true };
}

function kick(by: StreamUser, target: StreamUser, status: PersonStatus): { ok: true } | { error: string } {
  const reason = `${by.name} removed you`;
  const isPlayer = status === "playing" || status === "away";
  if (isPlayer && !by.admin) return { error: "Only an admin can remove the player." };
  // Whatever they asked for, the answer's no.
  for (const r of requests.values()) {
    if (r.from.id === target.id && r.state === "pending") {
      r.state = "declined";
      r.answeredAt = Date.now();
    }
  }
  for (const [id, o] of offers) if (o.to.id === target.id) offers.delete(id);
  endInvitesTo(target.id, reason);
  if (status === "waiting" || status === "held") {
    queue = queue.filter((q) => q.user.id !== target.id);
    if (reserved?.user.id === target.id) reserved = null;
    removed.set(target.id, { reason: `${by.name} took you out of the line`, until: Date.now() + REMOVED_MS });
    advanceQueue();
  }
  if (isPlayer) {
    endInvitesFrom(target.id, `${by.name} ended ${target.name}'s session`);
    for (const [socket, s] of streaming) {
      if (s.user.id !== target.id) continue;
      streaming.delete(socket);
      socketClose(socket, 4014, reason);
    }
    // Their game stays open, but it isn't theirs any more.
    if (owner?.user.id === target.id) owner = null;
    advanceQueue();
  }
  return { ok: true };
}

/** A guest taking up (or turning down) the player's offer of the PC. */
export function answerOffer(id: string, user: StreamUser, yes: boolean): { ok: true } | { error: string } {
  const offer = liveOffers().find((o) => o.id === id);
  if (!offer || offer.to.id !== user.id) return { error: "That offer isn't open any more." };
  offers.delete(id);
  if (yes) giveTo(user, offer.from.id, `Handed over to ${user.name}`);
  return { ok: true };
}

/** Forget everything (tests). */
export function resetSessions(): void {
  latestStreams.clear();
  invites.clear();
  offers.clear();
  removed.clear();
  padCounts.clear();
  guests.clear();
  streaming.clear();
  owner = null;
  sunshineBusy = false;
  activity.clear();
  queue = [];
  reserved = null;
  requests.clear();
}
