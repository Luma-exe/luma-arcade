import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  ABANDON_MS,
  ABANDON_QUEUED_MS,
  IDLE_MS,
  QUEUE_TURN_MS,
  answerRequest,
  checkQueue,
  decide,
  inbox,
  joinQueue,
  leaveQueue,
  mayStopSession,
  recordActivity,
  requestHandover,
  resetSessions,
  restoreOwner,
  setSunshineBusy,
  status,
  streamEnded,
  streamStarted,
} from "./sessions.js";
import type { StreamUser } from "./streamUser.js";
import { getDb, initDb } from "../db/index.js";

const alice: StreamUser = { id: 1, name: "Alice", roleId: 2, admin: false };
const bob: StreamUser = { id: 2, name: "Bob", roleId: 2, admin: false };
const carol: StreamUser = { id: 3, name: "Carol", roleId: 2, admin: false };
const admin: StreamUser = { id: 9, name: "Admin", roleId: 1, admin: true };

/** A stand-in for a stream's WebSocket. */
function socket() {
  return { closed: null as null | { code: number; reason: string }, close(code: number, reason: string) { this.closed = { code, reason }; } };
}

beforeEach(() => {
  mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_000_000 });
  resetSessions();
});
afterEach(() => mock.timers.reset());

describe("the PC lock", () => {
  it("lets anyone connect to a free PC", () => {
    assert.equal(decide(alice).allowed, true);
  });

  it("keeps others out while someone streams, and lets them ask or wait", () => {
    streamStarted(socket(), alice);
    const d = decide(bob);
    assert.equal(d.allowed, false);
    assert.equal(d.canRequest, true);
    assert.equal(d.canQueue, true);
    assert.equal(d.ownerName, "Alice");
    assert.equal(decide(alice).allowed, true);
  });

  it("lets an admin take over", () => {
    streamStarted(socket(), alice);
    const d = decide(admin);
    assert.equal(d.allowed, true);
    assert.equal(d.takeOver, true);
  });

  it("keeps a game that's still open for its player after they disconnect", () => {
    const s = socket();
    streamStarted(s, alice);
    streamEnded(s);
    setSunshineBusy(true);
    assert.equal(decide(bob).allowed, false);
    assert.equal(mayStopSession(bob), false);
    assert.equal(mayStopSession(alice), true);
  });

  it("frees the PC once Sunshine has closed the game", () => {
    const s = socket();
    streamStarted(s, alice);
    streamEnded(s);
    setSunshineBusy(false);
    assert.equal(decide(bob).allowed, true);
    assert.equal(status(bob).owner, null);
  });
});

describe("a LumaArcade restart", () => {
  it("keeps the game with its player, who gets the usual time to reconnect", () => {
    initDb(":memory:");
    streamStarted(socket(), alice);
    // (restart: memory is gone, the database isn't)
    const saved = getDb().prepare("SELECT value FROM settings WHERE key = 'pcOwner'").get();
    resetSessions();
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('pcOwner', ?)").run((saved as { value: string }).value);
    assert.equal(restoreOwner()?.name, "Alice");
    assert.equal(decide(bob).allowed, false);
    assert.equal(decide(alice).allowed, true);
    mock.timers.tick(ABANDON_MS + 1);
    assert.equal(decide(bob).allowed, true);
  });

  it("forgets the owner once Sunshine says the game is closed", () => {
    initDb(":memory:");
    streamStarted(socket(), alice);
    resetSessions();
    assert.equal(restoreOwner(), null);
    const s = socket();
    streamStarted(s, alice);
    streamEnded(s);
    setSunshineBusy(false);
    assert.equal(getDb().prepare("SELECT value FROM settings WHERE key = 'pcOwner'").get(), undefined);
  });
});

describe("abandoned games", () => {
  it("are released after ABANDON_MS with nobody streaming", () => {
    const s = socket();
    streamStarted(s, alice);
    streamEnded(s);
    setSunshineBusy(true);
    mock.timers.tick(ABANDON_MS - 1000);
    assert.equal(decide(bob).allowed, false);
    mock.timers.tick(2000);
    const d = decide(bob);
    assert.equal(d.allowed, true);
    assert.equal(d.takeOver, true, "taking an abandoned game is confirmed first");
    assert.equal(status(bob).abandoned, true);
    assert.equal(mayStopSession(bob), true, "anyone can close an abandoned game");
  });

  it("are released sooner when someone is waiting in line", () => {
    const s = socket();
    streamStarted(s, alice);
    streamEnded(s);
    setSunshineBusy(true);
    assert.equal("error" in joinQueue(bob), false);
    mock.timers.tick(ABANDON_QUEUED_MS + 1000);
    checkQueue(bob);
    assert.equal(checkQueue(bob).yourTurn, true);
    assert.equal(decide(bob).allowed, true);
    assert.equal(decide(carol).allowed, false, "held for Bob, not up for grabs");
  });

  it("aren't released while their player is still streaming", () => {
    streamStarted(socket(), alice);
    setSunshineBusy(true);
    mock.timers.tick(ABANDON_MS * 3);
    assert.equal(decide(bob).allowed, false);
  });
});

describe("hand-over requests", () => {
  it("need an answer from an active player", () => {
    streamStarted(socket(), alice);
    recordActivity(alice, 1000);
    const r = requestHandover(bob);
    assert.ok(!("error" in r));
    assert.equal(r.state, "pending");
    assert.equal(inbox(alice).requests.length, 1);
  });

  it("let the asker in once accepted, and close the old stream", () => {
    const s = socket();
    streamStarted(s, alice);
    const r = requestHandover(bob);
    assert.ok(!("error" in r));
    const answered = answerRequest(r.id, alice, true);
    assert.ok(!("error" in answered));
    assert.equal(answered.state, "accepted");
    assert.equal(decide(bob).allowed, true);
    mock.timers.tick(2000);
    assert.equal(s.closed?.code, 4010);
  });

  it("are handed over straight away when the player has been away", () => {
    const s = socket();
    streamStarted(s, alice);
    recordActivity(alice, IDLE_MS + 60_000);
    const r = requestHandover(bob);
    assert.ok(!("error" in r));
    assert.equal(r.state, "accepted");
    assert.equal(r.auto, true);
    mock.timers.tick(2000);
    assert.match(s.closed?.reason ?? "", /you were away/);
  });

  it("ignore stale activity reports", () => {
    streamStarted(socket(), alice);
    recordActivity(alice, IDLE_MS + 60_000);
    mock.timers.tick(5 * 60_000);
    const r = requestHandover(bob);
    assert.ok(!("error" in r));
    assert.equal(r.state, "pending");
  });

  it("can only be answered by the player they're for", () => {
    streamStarted(socket(), alice);
    const r = requestHandover(bob);
    assert.ok(!("error" in r));
    assert.ok("error" in answerRequest(r.id, carol, true));
  });

  it("lapse after their countdown", () => {
    streamStarted(socket(), alice);
    const r = requestHandover(bob);
    assert.ok(!("error" in r));
    mock.timers.tick(11_000);
    assert.equal(inbox(alice).requests.length, 0);
    assert.ok("error" in answerRequest(r.id, alice, true));
  });
});

describe("waiting in line", () => {
  it("can't be joined for a free PC", () => {
    assert.ok("error" in joinQueue(bob));
  });

  it("gives the PC to whoever is first once the player leaves", () => {
    const s = socket();
    streamStarted(s, alice);
    joinQueue(bob);
    joinQueue(carol);
    assert.equal(checkQueue(carol).position, 2);
    assert.deepEqual(inbox(alice).waiting, ["Bob", "Carol"]);

    streamEnded(s);
    setSunshineBusy(false);
    assert.equal(checkQueue(bob).yourTurn, true);
    assert.equal(checkQueue(carol).position, 1);
    assert.equal(decide(carol).allowed, false);
    assert.equal(decide(bob).allowed, true);

    streamStarted(socket(), bob);
    assert.equal(checkQueue(bob).yourTurn, false);
  });

  it("moves on when the next person doesn't connect in time", () => {
    const s = socket();
    streamStarted(s, alice);
    joinQueue(bob);
    joinQueue(carol);
    streamEnded(s);
    setSunshineBusy(false);
    // keep Carol's place alive while Bob's turn runs out
    for (let t = 0; t < QUEUE_TURN_MS + 5000; t += 10_000) {
      mock.timers.tick(10_000);
      checkQueue(carol);
    }
    assert.equal(checkQueue(carol).yourTurn, true);
  });

  it("drops people whose page stopped checking in", () => {
    streamStarted(socket(), alice);
    joinQueue(bob);
    mock.timers.tick(31_000);
    assert.equal(status(alice).waiting, 0);
  });

  it("can be left", () => {
    streamStarted(socket(), alice);
    joinQueue(bob);
    leaveQueue(bob);
    assert.equal(checkQueue(bob).position, null);
  });
});
