import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  AFK_KICK_MS,
  END_IDLE_MS,
  END_SOON_MS,
  adminKick,
  awayKickInMs,
  liveSessions,
  recordActivity,
  resetSessions,
  setSunshineBusy,
  status,
  streamEnded,
  streamStarted,
} from "./sessions.js";
import { forceStop, idleTick } from "./idle.js";
import type { StreamUser } from "./streamUser.js";

const alice: StreamUser = { id: 1, name: "Alice", roleId: 2, admin: false };
const bob: StreamUser = { id: 2, name: "Bob", roleId: 2, admin: false };
const admin: StreamUser = { id: 9, name: "Admin", roleId: 1, admin: true };

function socket() {
  return { closed: null as null | { code: number; reason: string }, close(code: number, reason: string) { this.closed = { code, reason }; } };
}

/** A stand-in for Sunshine's /cancel that counts its calls. */
function closer(ok = true) {
  const c = { calls: 0, close: async () => (c.calls++, ok) };
  return c;
}

beforeEach(() => {
  mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_000_000 });
  resetSessions();
});
afterEach(() => mock.timers.reset());

describe("away from the controls", () => {
  it("disconnects a player with no input for the away time, not before", async () => {
    const s = socket();
    streamStarted(s, alice);
    recordActivity(alice, 0);
    mock.timers.tick(AFK_KICK_MS - 60_000);
    assert.deepEqual((await idleTick(closer().close)).kicked, []);
    assert.equal(awayKickInMs(alice), 60_000);
    mock.timers.tick(60_000);
    assert.deepEqual((await idleTick(closer().close)).kicked, ["Alice"]);
    assert.equal(s.closed?.code, 4014);
    assert.match(s.closed!.reason, /no input/);
  });

  it("counts on from the last report when the page stops reporting", async () => {
    streamStarted(socket(), alice);
    recordActivity(alice, 5 * 60_000);
    mock.timers.tick(AFK_KICK_MS - 5 * 60_000);
    assert.deepEqual((await idleTick(closer().close)).kicked, ["Alice"]);
  });

  it("starts a new stream with a clean slate", async () => {
    streamStarted(socket(), alice);
    recordActivity(alice, AFK_KICK_MS - 1000);
    const again = socket();
    streamStarted(again, alice);
    assert.deepEqual((await idleTick(closer().close)).kicked, []);
    assert.equal(again.closed, null);
  });

  it("closes the game soon after an away kick", async () => {
    const s = socket();
    streamStarted(s, alice);
    setSunshineBusy(true);
    mock.timers.tick(AFK_KICK_MS);
    const c = closer();
    await idleTick(c.close);
    streamEnded(s);
    mock.timers.tick(END_SOON_MS - 1000);
    assert.equal((await idleTick(c.close)).closed, false);
    mock.timers.tick(1000);
    assert.equal((await idleTick(c.close)).closed, true);
    assert.equal(c.calls, 1);
    assert.equal(status(null).owner, null);
  });
});

describe("a game left open", () => {
  it("is closed once nobody has streamed it for a while", async () => {
    const s = socket();
    streamStarted(s, alice);
    setSunshineBusy(true);
    streamEnded(s);
    const c = closer();
    mock.timers.tick(END_IDLE_MS - 1000);
    assert.equal((await idleTick(c.close)).closed, false);
    assert.ok(liveSessions().closesInMs! > 0);
    mock.timers.tick(1000);
    assert.equal((await idleTick(c.close)).closed, true);
  });

  it("stays open while someone streams it", async () => {
    streamStarted(socket(), alice);
    setSunshineBusy(true);
    const c = closer();
    mock.timers.tick(END_IDLE_MS * 2);
    recordActivity(alice, 0);
    await idleTick(c.close);
    assert.equal(c.calls, 0);
  });

  it("keeps trying when Sunshine doesn't close it", async () => {
    const s = socket();
    streamStarted(s, alice);
    setSunshineBusy(true);
    streamEnded(s);
    mock.timers.tick(END_IDLE_MS);
    assert.equal((await idleTick(closer(false).close)).closed, false);
    assert.equal((await idleTick(closer(true).close)).closed, true);
  });
});

describe("admin controls", () => {
  it("removes anyone from the stream", () => {
    const s = socket();
    streamStarted(s, alice);
    assert.deepEqual(adminKick(admin, alice.id), { ok: true, closed: 1 });
    assert.equal(s.closed?.code, 4014);
    assert.equal(status(null).owner, null);
    assert.equal(liveSessions().people.length, 0);
  });

  it("is admin only", () => {
    streamStarted(socket(), alice);
    assert.ok("error" in adminKick(bob, alice.id));
  });

  it("force stop ends every stream and closes the game", async () => {
    const a = socket();
    streamStarted(a, alice);
    setSunshineBusy(true);
    const c = closer();
    assert.deepEqual(await forceStop("Admin", c.close), { disconnected: 1, closed: true });
    assert.match(a.closed!.reason, /Admin ended the session/);
    assert.equal(status(null).busy, false);
  });
});
