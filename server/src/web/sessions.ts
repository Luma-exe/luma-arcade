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
    guests: [...new Set([...guests.values()].map((g) => g.user.name))],
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

type RequestState = "pending" | "accepted" | "declined" | "expired" | "cancelled";

interface HandoverRequest {
  id: string;
  from: StreamUser;
  to: StreamUser;
  expiresAt: number;
  state: RequestState;
  answeredAt: number;
  /** Accepted by itself because the player was away. */
  auto: boolean;
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
  return {
    id: r.id,
    state: r.state,
    from: r.from.name,
    to: r.to.name,
    remainingMs: r.state === "pending" ? Math.max(0, r.expiresAt - Date.now()) : 0,
    timeoutMs: REQUEST_MS,
    auto: r.auto || undefined,
  };
}

/** Ask whoever is streaming to hand the PC over. Replaces this person's
 * earlier request, so asking again restarts the countdown. A player who's
 * been away from their controls for IDLE_MS hands over straight away. */
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
    auto: false,
  };
  requests.set(request.id, request);
  const idle = idleFor(other.user.id);
  if (idle !== null && idle >= IDLE_MS) {
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

/** The streamer's answer. Handing over lets the asker past the lock and
 * ends the streamer's own stream. */
export function answerRequest(id: string, user: StreamUser, yes: boolean): RequestView | { error: string } {
  refresh();
  const r = requests.get(id);
  if (!r || r.to.id !== user.id) return { error: "That request isn't for you." };
  if (r.state !== "pending") return { error: r.state === "expired" ? "That request already timed out." : "That request was already answered." };
  if (yes) accept(r, `Handed over to ${r.from.name}`);
  else {
    r.state = "declined";
    r.answeredAt = Date.now();
  }
  return view(r);
}

function accept(r: HandoverRequest, reason: string): void {
  r.state = "accepted";
  r.answeredAt = Date.now();
  endInvitesFrom(r.to.id, `${r.to.name} handed the PC over`);
  reserved = { user: r.from, until: Date.now() + HANDOVER_GRACE_MS, via: "handover" };
  owner = { user: r.from, since: Date.now(), lastSeen: Date.now() };
  queue = queue.filter((q) => q.user.id !== r.from.id);
  // Any other request for this PC is moot now.
  for (const other of requests.values()) {
    if (other !== r && other.to.id === r.to.id && other.state === "pending") {
      other.state = "declined";
      other.answeredAt = Date.now();
    }
  }
  const handedOverBy = r.to.id;
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

interface Invite {
  id: string;
  from: StreamUser;
  to: StreamUser;
  stream: CoopStream;
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
  stream: CoopStream;
}

function inviteView(i: Invite): InviteView {
  return { id: i.id, from: i.from.name, to: i.to.name, state: i.state, stream: i.stream };
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

/** The player invites someone to play along. Asking the same person again
 * replaces their earlier invite. */
export function createInvite(from: StreamUser, to: StreamUser, stream: CoopStream): InviteView | { error: string } {
  if (to.id === from.id) return { error: "You can't invite yourself." };
  if (!isStreaming(from.id) || owner?.user.id !== from.id) return { error: "Only the person playing can invite someone." };
  for (const i of invites.values()) {
    if (i.from.id === from.id && i.to.id === to.id && i.state === "pending") i.state = "ended";
  }
  const invite: Invite = { id: randomUUID(), from, to, stream, state: "pending", expiresAt: Date.now() + INVITE_MS };
  invites.set(invite.id, invite);
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

/** Guests may play, but not close the game, go Home or switch windows. */
export function isGuest(user: StreamUser): boolean {
  return !!activeInviteFor(user) && owner?.user.id !== user.id;
}

/** The app a guest must stream: their invite's. */
export function guestStream(user: StreamUser): CoopStream | null {
  return activeInviteFor(user)?.stream ?? null;
}

/** Forget everything (tests). */
export function resetSessions(): void {
  latestStreams.clear();
  invites.clear();
  guests.clear();
  streaming.clear();
  owner = null;
  sunshineBusy = false;
  activity.clear();
  queue = [];
  reserved = null;
  requests.clear();
}
