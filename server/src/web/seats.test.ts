import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLAIM_MS,
  HOLD_MS,
  claimSeat,
  isSeatHost,
  resetSeats,
  seatDecision,
  seatOf,
  seatAt,
  seatHolder,
  seatOffer,
  seatStreamEnded,
  seatStreamStarted,
  setSeatDeps,
  type Seat,
} from "./seats.js";
import { setLastPc, setSyncDeps } from "./saveSync.js";
import type { StreamUser } from "./streamUser.js";

const alice: StreamUser = { id: 1, name: "Alice", roleId: 2, admin: false };
const bob: StreamUser = { id: 2, name: "Bob", roleId: 2, admin: false };
const carol: StreamUser = { id: 3, name: "Carol", roleId: 2, admin: false };
const admin: StreamUser = { id: 9, name: "Admin", roleId: 1, admin: true };

const seat2: Seat = { hostId: 200, name: "Seat2", address: "10.0.0.2", httpPort: 47989, owner: null };
const seat3: Seat = { hostId: 300, name: "Seat3", address: "10.0.0.3", httpPort: 47989, owner: null };

let closed: number[] = [];
function useSeats(seats: Seat[], offline: number[] = []) {
  setSeatDeps({ seats: () => seats, online: async (s) => !offline.includes(s.hostId), close: async (s) => void closed.push(s.hostId) });
}

describe("seats", () => {
  let home: Record<string, string> = {};
  beforeEach(() => {
    closed = [];
    home = {};
    setSyncDeps({ readHome: () => ({ ...home }), writeHome: (h) => void (home = { ...h }), exportMain: async () => {}, exportSeat: async () => {}, toSeat: async () => {}, importMain: async () => {}, importSeat: async () => {} });
    resetSeats();
    useSeats([seat2]);
  });
  afterEach(() => {
    setSeatDeps(null);
    setSyncDeps(null);
  });

  it("knows which hosts are seats", () => {
    assert.equal(isSeatHost(200), true);
    assert.equal(isSeatHost(1), false);
  });

  it("gives a free seat and keeps it for that person", async () => {
    assert.deepEqual(await seatOffer(alice), { available: true, yours: false, name: "Seat2" });
    assert.equal((await claimSeat(alice))?.hostId, 200);
    assert.deepEqual(await seatOffer(alice), { available: true, yours: true, name: "Seat2" });
    // Claiming again is the same seat, not a second one.
    assert.equal((await claimSeat(alice))?.hostId, 200);
    assert.deepEqual(await seatOffer(bob), { available: false, yours: false });
    assert.equal(await claimSeat(bob), null);
  });

  it("closes the last player's game for a new player, not for the same one", async () => {
    await claimSeat(alice);
    assert.deepEqual(closed, [200]);
    setLastPc(alice.id, "Seat2");
    await claimSeat(alice);
    assert.deepEqual(closed, [200]);
  });

  it("closes their own seat's game when they played elsewhere since", async () => {
    await claimSeat(alice);
    setLastPc(alice.id, "main");
    await claimSeat(alice);
    assert.deepEqual(closed, [200, 200]);
  });

  it("knows a seat by its address and who has it", async () => {
    await claimSeat(alice);
    assert.equal(seatAt("10.0.0.2")?.hostId, 200);
    assert.equal(seatAt("10.9.9.9"), null);
    assert.equal(seatHolder(200)?.name, "Alice");
  });

  it("skips seats that are off", async () => {
    useSeats([seat2, seat3], [200]);
    assert.equal((await claimSeat(alice))?.hostId, 300);
  });

  it("only offers seats moonlight lets them use", async () => {
    useSeats([{ ...seat2, owner: admin.id }]);
    assert.deepEqual(await seatOffer(alice), { available: false, yours: false });
    assert.equal(await claimSeat(alice), null);
    assert.equal((await claimSeat(admin))?.hostId, 200);
  });

  it("refuses someone else's seat, lets an admin take it", async () => {
    await claimSeat(alice);
    assert.equal(seatDecision(200, bob).allowed, false);
    assert.match(seatDecision(200, bob).reason ?? "", /Alice is using Seat2/);
    assert.equal(seatStreamStarted(200, bob, {}).allowed, false);
    assert.equal(seatDecision(200, admin).allowed, true);
    assert.equal(seatStreamStarted(200, alice, {}).allowed, true);
  });

  it("a claim lapses if the stream never starts", async () => {
    const t = Date.now();
    await claimSeat(alice, t);
    assert.equal(seatOf(alice.id, t + CLAIM_MS - 1)?.hostId, 200);
    assert.equal(seatOf(alice.id, t + CLAIM_MS + 1), null);
    assert.equal(seatDecision(200, bob, t + CLAIM_MS + 1).allowed, true);
  });

  it("holds the seat for a while after the stream closes", () => {
    const t = Date.now();
    const socket = {};
    seatStreamStarted(200, alice, socket, t);
    assert.equal(seatStreamEnded(socket, t + 1000), true);
    assert.equal(seatDecision(200, bob, t + 1000 + HOLD_MS - 1).allowed, false);
    assert.equal(seatDecision(200, bob, t + 1000 + HOLD_MS + 1).allowed, true);
  });

  it("stays taken while any of their streams is open (quality switches)", () => {
    const t = Date.now();
    const a = {};
    const b = {};
    seatStreamStarted(200, alice, a, t);
    seatStreamStarted(200, alice, b, t);
    seatStreamEnded(a, t);
    assert.equal(seatDecision(200, carol, t + HOLD_MS * 2).allowed, false);
    seatStreamEnded(b, t + HOLD_MS * 2);
    assert.equal(seatDecision(200, carol, t + HOLD_MS * 3 + 1).allowed, true);
  });

  it("isn't a seat stream when the socket isn't one", () => {
    assert.equal(seatStreamEnded({}), false);
  });
});
