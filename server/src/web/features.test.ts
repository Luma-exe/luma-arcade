import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { getDb, initDb } from "../db/index.js";
import { activeAnnouncements, postAnnouncement, removeAnnouncement } from "./announcements.js";
import { enforceTimeLimits } from "./appAccess.js";
import { setLimits, timeLeft } from "./limits.js";
import { badSample, playEnded, playStarted, playSummary, recordQuality } from "./playLog.js";
import {
  answerInvite,
  createInvite,
  decide,
  endInvite,
  invitesFor,
  isGuest,
  mayStopSession,
  requestHandover,
  answerRequest,
  resetSessions,
  status,
  streamStarted,
} from "./sessions.js";
import type { StreamUser } from "./streamUser.js";

const alice: StreamUser = { id: 1, name: "Alice", roleId: 2, admin: false };
const bob: StreamUser = { id: 2, name: "Bob", roleId: 2, admin: false };
const carol: StreamUser = { id: 3, name: "Carol", roleId: 2, admin: false };
const STREAM = { hostId: 7, appId: 1, width: 1920, height: 1080, fps: 60 };

function socket() {
  return { closed: null as null | { code: number; reason: string }, close(code: number, reason: string) { this.closed = { code, reason }; } };
}

before(() => initDb(":memory:"));
beforeEach(() => {
  // 10:00 local time on a Wednesday
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date(2026, 8, 30, 10, 0, 0).getTime() });
  resetSessions();
  getDb().exec("DELETE FROM play_sessions; DELETE FROM user_access; DELETE FROM announcements;");
});
afterEach(() => mock.timers.reset());

describe("co-op", () => {
  it("lets an invited player join as a guest without taking the PC", () => {
    streamStarted(socket(), alice);
    const invite = createInvite(alice, bob, STREAM);
    assert.ok(!("error" in invite));
    assert.equal(decide(bob).allowed, false, "not before they accept");
    assert.equal(invitesFor(bob).length, 1);
    assert.ok(!("error" in answerInvite(invite.id, bob, true)));
    const d = decide(bob);
    assert.equal(d.allowed, true);
    assert.equal(d.guest, true);
    assert.equal(streamStarted(socket(), bob), "guest");
    assert.deepEqual(status(carol).guests, ["Bob"]);
    assert.equal(status(carol).owner?.name, "Alice", "Alice still has the PC");
    assert.equal(isGuest(bob), true);
    assert.equal(mayStopSession(bob), false, "guests can't close the game");
    assert.equal(decide(carol).allowed, false, "Carol still can't barge in");
  });

  it("only lets the person playing invite", () => {
    streamStarted(socket(), alice);
    assert.ok("error" in createInvite(bob, carol, STREAM));
    assert.ok("error" in createInvite(alice, alice, STREAM));
  });

  it("ends when the player ends it, closing the guest's stream", () => {
    streamStarted(socket(), alice);
    const invite = createInvite(alice, bob, STREAM);
    assert.ok(!("error" in invite));
    answerInvite(invite.id, bob, true);
    const guestSocket = socket();
    streamStarted(guestSocket, bob);
    endInvite(invite.id, alice);
    assert.equal(guestSocket.closed?.code, 4011);
    assert.equal(decide(bob).allowed, false);
  });

  it("ends when the player hands the PC over", () => {
    streamStarted(socket(), alice);
    const invite = createInvite(alice, bob, STREAM);
    assert.ok(!("error" in invite));
    answerInvite(invite.id, bob, true);
    const guestSocket = socket();
    streamStarted(guestSocket, bob);
    const r = requestHandover(carol);
    assert.ok(!("error" in r));
    answerRequest(r.id, alice, true);
    assert.equal(guestSocket.closed?.code, 4011);
  });

  it("can't be answered by someone else", () => {
    streamStarted(socket(), alice);
    const invite = createInvite(alice, bob, STREAM);
    assert.ok(!("error" in invite));
    assert.ok("error" in answerInvite(invite.id, carol, true));
  });
});

describe("time limits", () => {
  it("counts today's play against a daily limit", () => {
    setLimits(2, { dailyMinutes: 60 });
    const row = playStarted(2, "Bob", "ES-DE");
    mock.timers.tick(45 * 60_000);
    playEnded(row);
    const left = timeLeft(bob);
    assert.equal(left.remainingMs, 15 * 60_000);
    mock.timers.tick(60_000);
    const row2 = playStarted(2, "Bob", "Desktop");
    mock.timers.tick(15 * 60_000);
    assert.equal(timeLeft(bob).remainingMs, 0);
    assert.match(timeLeft(bob).reason ?? "", /today/);
    playEnded(row2);
  });

  it("uses the tighter of the daily and weekly limits", () => {
    setLimits(2, { dailyMinutes: 120, weeklyMinutes: 30 });
    const row = playStarted(2, "Bob", "ES-DE");
    mock.timers.tick(10 * 60_000);
    playEnded(row);
    assert.equal(timeLeft(bob).remainingMs, 20 * 60_000);
  });

  it("resets the next day", () => {
    setLimits(2, { dailyMinutes: 30 });
    const row = playStarted(2, "Bob", "ES-DE");
    mock.timers.tick(30 * 60_000);
    playEnded(row);
    assert.equal(timeLeft(bob).remainingMs, 0);
    mock.timers.tick(24 * 3_600_000);
    assert.equal(timeLeft(bob).remainingMs, 30 * 60_000);
  });

  it("never limits admins, or people without a limit", () => {
    assert.equal(timeLeft({ ...alice, admin: true }).remainingMs, null);
    assert.equal(timeLeft(alice).remainingMs, null);
  });

  it("ends a running stream once the time is up", () => {
    // enforceTimeLimits only sees streams opened through the proxy; with
    // none open it must simply do nothing.
    setLimits(2, { dailyMinutes: 1 });
    enforceTimeLimits();
  });
});

describe("stream quality", () => {
  it("grades laggy and lossy samples, not still screens", () => {
    assert.equal(badSample({ fps: 59, targetFps: 60, rttMs: 20 }), false);
    assert.equal(badSample({ fps: 40, targetFps: 60 }), false, "a still screen sends fewer frames");
    assert.equal(badSample({ rttMs: 150 }), true);
    assert.equal(badSample({ frames: 1800, dropped: 100 }), true);
    assert.equal(badSample({ packets: 10000, lost: 500 }), true);
  });

  it("sums samples onto the open play row", () => {
    const row = playStarted(1, "Alice", "ES-DE");
    recordQuality(1, { kbps: 20000, fps: 60, rttMs: 10, frames: 1800, dropped: 0, packets: 20000, lost: 0, width: 1920, height: 1080, targetFps: 60 });
    recordQuality(1, { kbps: 10000, fps: 30, rttMs: 30, frames: 900, dropped: 90, packets: 10000, lost: 100, targetFps: 60 });
    mock.timers.tick(60_000);
    playEnded(row);
    const q = playSummary(1).sessions[0].quality;
    assert.ok(q);
    assert.equal(q.kbps, 15000);
    assert.equal(q.fps, 45);
    assert.equal(q.worstRttMs, 30);
    assert.equal(q.badMinutes, 0.5);
    assert.equal(q.size, "1920x1080");
    assert.equal(q.droppedPct, 3.33);
  });

  it("ignores junk values", () => {
    const row = playStarted(1, "Alice", "ES-DE");
    recordQuality(1, { kbps: -5, fps: Number.NaN, rttMs: "x" as unknown as number });
    playEnded(row);
    const q = playSummary(1).sessions[0].quality;
    assert.equal(q?.kbps, 0);
  });
});

describe("announcements", () => {
  it("show until they expire or are removed", () => {
    const a = postAnnouncement("PC restarting at 11pm", "admin", 2);
    postAnnouncement("  Welcome!  ", "admin", undefined);
    assert.deepEqual(activeAnnouncements().map((x) => x.text).sort(), ["PC restarting at 11pm", "Welcome!"]);
    mock.timers.tick(3 * 3_600_000);
    assert.deepEqual(activeAnnouncements().map((x) => x.text), ["Welcome!"]);
    removeAnnouncement(activeAnnouncements()[0].id);
    assert.equal(activeAnnouncements().length, 0);
    assert.ok(a.expiresAt);
  });

  it("need some text", () => {
    assert.throws(() => postAnnouncement("   ", "admin", 1));
  });
});
