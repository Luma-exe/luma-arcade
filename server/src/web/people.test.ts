import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  answerOffer,
  answerRequest,
  checkQueue,
  decide,
  guestRoleOf,
  joinQueue,
  manage,
  people,
  recordConnection,
  recordStream,
  requestHandover,
  resetSessions,
  status,
  streamEnded,
  streamStarted,
} from "./sessions.js";
import type { StreamUser } from "./streamUser.js";

const alice: StreamUser = { id: 1, name: "Alice", roleId: 2, admin: false };
const bob: StreamUser = { id: 2, name: "Bob", roleId: 2, admin: false };
const carol: StreamUser = { id: 3, name: "Carol", roleId: 2, admin: false };
const admin: StreamUser = { id: 9, name: "Admin", roleId: 1, admin: true };
const STREAM = { hostId: 7, appId: 1, width: 1920, height: 1080, fps: 60 };

function socket() {
  return { closed: null as null | { code: number; reason: string }, close(code: number, reason: string) { this.closed = { code, reason }; } };
}

function ok<T extends object>(result: T | { error: string }): T {
  assert.ok(!("error" in result), "error" in result ? result.error : "");
  return result as T;
}

beforeEach(() => {
  mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_000_000 });
  resetSessions();
});
afterEach(() => mock.timers.reset());

/** Alice playing, Bob let in as `kind` from the connect screen. */
function bobJoins(kind: "player2" | "spectate") {
  const aliceSocket = socket();
  streamStarted(aliceSocket, alice);
  const r = ok(requestHandover(bob, kind));
  const answered = ok(answerRequest(r.id, alice, true, undefined, STREAM));
  const bobSocket = socket();
  assert.equal(decide(bob).guest, true);
  assert.equal(streamStarted(bobSocket, bob), "guest");
  return { aliceSocket, bobSocket, answered };
}

describe("asking to join", () => {
  it("lets someone in as player 2 without taking the PC", () => {
    const { answered } = bobJoins("player2");
    assert.equal(answered.granted, "player2");
    assert.equal(answered.invite?.stream.width, 1920);
    assert.equal(guestRoleOf(bob), "player2");
    assert.equal(status(carol).owner?.name, "Alice");
    assert.deepEqual(status(carol).guests, ["Bob"]);
  });

  it("lets someone in to watch", () => {
    bobJoins("spectate");
    assert.equal(guestRoleOf(bob), "spectator");
    assert.deepEqual(status(carol).spectators, ["Bob"]);
    assert.deepEqual(status(carol).guests, []);
  });

  it("lets the player give something else than was asked for", () => {
    streamStarted(socket(), alice);
    const r = ok(requestHandover(bob, "player2"));
    const answered = ok(answerRequest(r.id, alice, true, "spectate", STREAM));
    assert.equal(answered.invite?.role, "spectator");
  });

  it("needs the player's stream, or a recent report of it", () => {
    streamStarted(socket(), alice);
    const r = ok(requestHandover(bob, "player2"));
    assert.ok("error" in answerRequest(r.id, alice, true));
    recordStream(alice, STREAM);
    ok(answerRequest(r.id, alice, true));
  });

  it("isn't handed over automatically when the player is away", () => {
    streamStarted(socket(), alice);
    const r = ok(requestHandover(bob, "spectate"));
    assert.equal(r.state, "pending");
    assert.equal(r.timeoutMs, 30_000);
  });
});

describe("the people panel", () => {
  it("lists everyone with what they're doing", () => {
    bobJoins("player2");
    ok(requestHandover(carol, "spectate"));
    const view = people(alice);
    assert.equal(view.canManage, true);
    assert.deepEqual(
      view.people.map((p) => [p.name, p.status]),
      [["Alice", "playing"], ["Bob", "player2"], ["Carol", "asking"]]
    );
    assert.equal(view.people.find((p) => p.name === "Carol")?.kind, "spectate");
    assert.equal(people(bob).canManage, false);
    assert.equal(people(bob).you.role, "player2");
    assert.equal(people(admin).canManage, true);
  });

  it("switches a guest between player 2 and watching", () => {
    bobJoins("player2");
    ok(manage(alice, bob.id, "spectator"));
    assert.equal(guestRoleOf(bob), "spectator");
    ok(manage(alice, bob.id, "player2"));
    assert.equal(guestRoleOf(bob), "player2");
  });

  it("only lets the player or an admin act", () => {
    bobJoins("player2");
    assert.ok("error" in manage(bob, alice.id, "kick"));
    assert.ok("error" in manage(carol, bob.id, "kick"));
    ok(manage(admin, bob.id, "spectator"));
  });

  it("kicks a guest, closing their stream", () => {
    const { bobSocket } = bobJoins("player2");
    ok(manage(alice, bob.id, "kick"));
    assert.equal(bobSocket.closed?.code, 4011);
    assert.equal(decide(bob).allowed, false);
    assert.equal(people(alice).people.length, 1);
  });

  it("takes someone out of the line and keeps them out for a while", () => {
    streamStarted(socket(), alice);
    ok(joinQueue(bob));
    ok(manage(alice, bob.id, "kick"));
    const view = checkQueue(bob);
    assert.equal(view.position, null);
    assert.match(view.removed ?? "", /Alice/);
    assert.ok("error" in joinQueue(bob));
  });

  it("invites someone waiting in line, who sees it from the line", () => {
    streamStarted(socket(), alice);
    ok(joinQueue(bob));
    ok(manage(alice, bob.id, "player2", STREAM));
    assert.equal(checkQueue(bob).invite?.role, "player2");
  });

  it("hands the PC straight to someone waiting in line", () => {
    const aliceSocket = socket();
    streamStarted(aliceSocket, alice);
    ok(joinQueue(bob));
    ok(manage(alice, bob.id, "handover"));
    assert.equal(decide(bob).allowed, true);
    mock.timers.tick(2000);
    assert.equal(aliceSocket.closed?.code, 4010);
  });

  it("offers the PC to a guest, who can take it", () => {
    const { aliceSocket } = bobJoins("spectate");
    ok(manage(alice, bob.id, "handover"));
    const offer = people(bob).offers[0];
    assert.equal(offer?.from, "Alice");
    ok(answerOffer(offer.id, bob, true));
    const d = decide(bob);
    assert.equal(d.allowed, true);
    assert.equal(d.guest, undefined, "joins as the player now");
    mock.timers.tick(2000);
    assert.equal(aliceSocket.closed?.code, 4010);
  });

  it("drops an offer that's turned down or lapses", () => {
    bobJoins("player2");
    ok(manage(alice, bob.id, "handover"));
    ok(answerOffer(people(bob).offers[0].id, bob, false));
    assert.equal(people(bob).offers.length, 0);
    ok(manage(alice, bob.id, "handover"));
    mock.timers.tick(31_000);
    assert.equal(people(bob).offers.length, 0);
  });

  it("lets only an admin remove the player", () => {
    const aliceSocket = socket();
    streamStarted(aliceSocket, alice);
    ok(requestHandover(bob, "spectate"));
    assert.ok("error" in manage(alice, alice.id, "kick"));
    ok(manage(admin, alice.id, "kick"));
    assert.equal(aliceSocket.closed?.code, 4014);
    assert.equal(decide(bob).allowed, true, "the PC is free");
  });
});

describe("up to four players", () => {
  const dave: StreamUser = { id: 4, name: "Dave", roleId: 2, admin: false };
  const erin: StreamUser = { id: 5, name: "Erin", roleId: 2, admin: false };

  /** Let `who` in as `kind` and join their stream. */
  function letIn(who: StreamUser, kind: "player2" | "spectate") {
    const r = ok(requestHandover(who, kind));
    ok(answerRequest(r.id, alice, true, undefined, STREAM));
    assert.equal(streamStarted(socket(), who), "guest");
  }

  /** Alice playing, and `who` joined as players. */
  function game(...who: StreamUser[]) {
    streamStarted(socket(), alice);
    for (const u of who) letIn(u, "player2");
  }

  it("gives each player their own block of controller numbers", () => {
    game(bob, carol, dave);
    assert.equal(people(alice).you.slotBase, 0);
    assert.deepEqual([bob, carol, dave].map((u) => people(u).you.slotBase), [4, 8, 12]);
  });

  it("turns a fifth player away, but lets them watch", () => {
    game(bob, carol, dave);
    assert.match((requestHandover(erin, "player2") as { error: string }).error, /full/);
    ok(requestHandover(erin, "spectate"));
  });

  it("counts controllers from one computer toward the four", () => {
    game(bob);
    people(alice, 2);
    assert.equal(people(bob).you.padLimit, 2, "two left for Bob");
    people(bob, 1);
    people(alice, 3);
    assert.equal(people(bob).you.padLimit, 1);
    assert.match((requestHandover(carol, "player2") as { error: string }).error, /4 controllers/);
  });

  it("gives spectators no controllers, and a seat when they start playing", () => {
    game(bob);
    letIn(carol, "spectate");
    assert.equal(people(carol).you.padLimit, 0);
    ok(manage(alice, carol.id, "player2"));
    assert.equal(people(carol).you.slotBase, 8, "the next free seat");
    assert.equal(people(carol).you.padLimit, 4);
  });

  it("frees a seat when someone switches to watching", () => {
    game(bob, carol, dave);
    ok(manage(alice, bob.id, "spectator"));
    ok(requestHandover(erin, "player2"));
  });

  it("won't switch a spectator to playing when the game is full", () => {
    game(bob, carol, dave);
    letIn(erin, "spectate");
    assert.ok("error" in manage(alice, erin.id, "player2"));
  });

  it("numbers players in the order their controllers joined", () => {
    game(bob);
    people(bob, 1);
    mock.timers.tick(1000);
    people(alice, 2);
    const numbers = Object.fromEntries(people(alice).people.map((p) => [p.name, p.players]));
    assert.deepEqual(numbers.Bob, [1]);
    assert.deepEqual(numbers.Alice, [2, 3]);
  });
});

describe("switching streams (Automatic quality)", () => {
  it("lets the player open a second stream and close the first without losing the PC", () => {
    const first = socket();
    streamStarted(first, alice);
    assert.equal(decide(alice).allowed, true, "their own second stream is let in");
    const second = socket();
    assert.equal(streamStarted(second, alice), "owner");
    streamEnded(first);
    assert.equal(decide(bob).allowed, false, "still Alice's PC");
    assert.equal(people(alice).you.status, "playing");
  });

  it("lets a guest switch too, keeping their seat and the co-op", () => {
    streamStarted(socket(), alice);
    const r = ok(requestHandover(bob, "player2"));
    ok(answerRequest(r.id, alice, true, undefined, STREAM));
    const first = socket();
    streamStarted(first, bob);
    const seat = people(bob).you.slotBase;
    assert.equal(decide(bob).guest, true, "their new stream joins as a guest again");
    assert.equal(streamStarted(socket(), bob), "guest");
    streamEnded(first);
    assert.equal(people(bob).you.role, "player2");
    assert.equal(people(bob).you.slotBase, seat);
  });
});

describe("connection grades", () => {
  it("shows each streamer's connection from their last report, until it's stale", () => {
    streamStarted(socket(), alice);
    assert.equal(recordConnection(alice, { packets: 30000, lost: 0, frames: 1800, dropped: 0, kbps: 12000 }), "good");
    let me = people(alice).people.find((p) => p.id === alice.id)!;
    assert.equal(me.connection, "good");
    assert.equal(me.connectionDetail, "0% packets lost · 12.0 Mbps");
    // Ben's bursts: 20k of ~37k packets lost in 30 s
    assert.equal(recordConnection(alice, { packets: 17000, lost: 20000, frames: 1000, dropped: 0 }), "poor");
    assert.equal(recordConnection(alice, { packets: 30000, lost: 300, frames: 1800, dropped: 0 }), "fair");
    mock.timers.tick(80_000);
    me = people(alice).people.find((p) => p.id === alice.id)!;
    assert.equal(me.connection, undefined);
  });

  it("doesn't judge a paused stream", () => {
    assert.equal(recordConnection(alice, { packets: 50, lost: 10, frames: 5, dropped: 0 }), null);
  });
});
