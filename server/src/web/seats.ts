import { listDevices } from "../remote/moonlightData.js";
import type { StreamUser } from "./streamUser.js";

// Extra seats: more Windows PCs to stream (Hyper-V VMs with a slice of the
// GPU and their own Sunshine), paired in moonlight-web-stream under a name
// like "Seat2". People only ever see and click the main PC; when it's in use,
// "Start a new session" on the stream page's "X is using this PC" screen
// gives them a free seat (claimSeat), and the page connects there instead.
//
// A seat is one person's. Its streams are checked here, not by sessions.ts
// (which is the main PC's one-screen lock): someone else's seat is refused,
// and a seat stays its player's for HOLD_MS after their stream closes, so a
// dropped connection, a quality switch or a quick break doesn't lose it.

/** A moonlight host with a name like this is a seat. */
export const SEAT_NAME = /^seat\s*\d+$/i;
/** A seat stays its player's this long after their last stream closes. */
export const HOLD_MS = 10 * 60_000;
/** A claimed seat waits this long for its player's stream to start. */
export const CLAIM_MS = 2 * 60_000;
/** How long a seat's "is it on" check is trusted. */
const ONLINE_CACHE_MS = 15_000;

export interface Seat {
  hostId: number;
  name: string;
  address: string;
  httpPort: number;
  /** moonlight user id it's paired for, or null for everyone. */
  owner: number | null;
}

interface Holder {
  user: StreamUser;
  /** Its open stream sockets. */
  sockets: Set<object>;
  /** When the last of them closed (or it was claimed). */
  lastSeen: number;
  /** Claimed, and no stream has started yet. */
  claimedUntil: number | null;
}

export interface SeatDeps {
  seats(): Seat[];
  /** Does the seat's Sunshine answer? */
  online(seat: Seat): Promise<boolean>;
}

const realDeps: SeatDeps = {
  seats: () =>
    listDevices()
      .filter((d) => SEAT_NAME.test(d.name) && d.paired)
      .map((d) => ({ hostId: d.id, name: d.name, address: d.address, httpPort: d.httpPort, owner: d.owner })),
  online: async (seat) => {
    try {
      const res = await fetch(`http://${seat.address}:${seat.httpPort}/serverinfo`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  },
};

let deps: SeatDeps = realDeps;
const holders = new Map<number, Holder>();
const onlineCache = new Map<number, { online: boolean; at: number }>();
let seatCache: { seats: Seat[]; at: number } | null = null;

/** Tests: fake seats and their on/off state. */
export function setSeatDeps(next: SeatDeps | null): void {
  deps = next ?? realDeps;
  seatCache = null;
}

export function resetSeats(): void {
  holders.clear();
  onlineCache.clear();
  seatCache = null;
}

export function listSeats(now = Date.now()): Seat[] {
  if (!seatCache || now - seatCache.at > 10_000) {
    let seats: Seat[] = [];
    try {
      seats = deps.seats();
    } catch {
      // moonlight's data file unreadable: no seats
    }
    seatCache = { seats, at: now };
  }
  return seatCache.seats;
}

export function isSeatHost(hostId: number): boolean {
  return listSeats().some((s) => s.hostId === hostId);
}

/** Whoever has this seat right now (streaming, holding it, or claimed it). */
function holderOf(hostId: number, now = Date.now()): Holder | null {
  const h = holders.get(hostId);
  if (!h) return null;
  if (h.sockets.size > 0) return h;
  if (h.claimedUntil !== null && h.claimedUntil > now) return h;
  if (h.claimedUntil === null && now - h.lastSeen < HOLD_MS) return h;
  holders.delete(hostId);
  return null;
}

/** The seat this person has, if any. */
export function seatOf(userId: number, now = Date.now()): Seat | null {
  for (const seat of listSeats(now)) {
    if (holderOf(seat.hostId, now)?.user.id === userId) return seat;
  }
  return null;
}

async function isOnline(seat: Seat, now = Date.now()): Promise<boolean> {
  const cached = onlineCache.get(seat.hostId);
  if (cached && now - cached.at < ONLINE_CACHE_MS) return cached.online;
  const online = await deps.online(seat);
  onlineCache.set(seat.hostId, { online, at: Date.now() });
  return online;
}

/** moonlight only lets its owner (or everyone, unowned) stream a host. */
function canUse(seat: Seat, user: StreamUser): boolean {
  return seat.owner === null || seat.owner === user.id;
}

async function freeSeat(user: StreamUser, now = Date.now()): Promise<Seat | null> {
  for (const seat of listSeats(now)) {
    if (!canUse(seat, user) || holderOf(seat.hostId, now)) continue;
    if (await isOnline(seat, now)) return seat;
  }
  return null;
}

/** What the "in use" screen can offer: back to their seat, or a new one. */
export async function seatOffer(user: StreamUser, now = Date.now()): Promise<{ available: boolean; yours: boolean; name?: string }> {
  const mine = seatOf(user.id, now);
  if (mine) return { available: true, yours: true, name: mine.name };
  const free = await freeSeat(user, now);
  return free ? { available: true, yours: false, name: free.name } : { available: false, yours: false };
}

/** Give this person a seat: theirs if they have one, else a free one, held
 * for CLAIM_MS until their stream starts. null when every seat is taken. */
export async function claimSeat(user: StreamUser, now = Date.now()): Promise<Seat | null> {
  const mine = seatOf(user.id, now);
  if (mine) return mine;
  const seat = await freeSeat(user, now);
  if (!seat) return null;
  holders.set(seat.hostId, { user, sockets: new Set(), lastSeen: now, claimedUntil: now + CLAIM_MS });
  return seat;
}

/** May this person stream this seat? (Its stream page asks first.) */
export function seatDecision(hostId: number, user: StreamUser, now = Date.now()): { allowed: boolean; reason?: string } {
  const h = holderOf(hostId, now);
  if (!h || h.user.id === user.id) return { allowed: true };
  const seat = listSeats(now).find((s) => s.hostId === hostId);
  if (user.admin) return { allowed: true, reason: `${h.user.name} has ${seat?.name ?? "this seat"}. Connecting takes it over.` };
  return { allowed: false, reason: `${h.user.name} is using ${seat?.name ?? "this seat"}. Go back and start a new session from the main PC.` };
}

/** A seat stream's Init message: theirs now, or refused. */
export function seatStreamStarted(hostId: number, user: StreamUser, socket: object, now = Date.now()): { allowed: boolean; reason?: string } {
  const decision = seatDecision(hostId, user, now);
  if (!decision.allowed) return decision;
  const h = holderOf(hostId, now);
  if (h && h.user.id === user.id) {
    h.sockets.add(socket);
    h.claimedUntil = null;
    h.lastSeen = now;
  } else {
    // Free, or an admin taking it over: the old holder's streams stay
    // open until Sunshine ends them, but the seat is the admin's now.
    holders.set(hostId, { user, sockets: new Set([socket]), lastSeen: now, claimedUntil: null });
  }
  return { allowed: true };
}

/** A stream closed: true when it was a seat's (then sessions.ts skips it). */
export function seatStreamEnded(socket: object, now = Date.now()): boolean {
  for (const h of holders.values()) {
    if (h.sockets.delete(socket)) {
      if (h.sockets.size === 0) h.lastSeen = now;
      return true;
    }
  }
  return false;
}

/** Admin screen: every seat and who has it. */
export function seatsStatus(now = Date.now()): { hostId: number; name: string; user: string | null; streaming: boolean }[] {
  return listSeats(now).map((seat) => {
    const h = holderOf(seat.hostId, now);
    return { hostId: seat.hostId, name: seat.name, user: h?.user.name ?? null, streaming: (h?.sockets.size ?? 0) > 0 };
  });
}
