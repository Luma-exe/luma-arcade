import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { getDb, initDb } from "../db/index.js";
import { isAppAllowed, setAccess } from "./access.js";
import { checkStreamInit, enforceTimeLimits, filterAppList, rememberSocketAccess, streamClosed, streamSocketOpened } from "./appAccess.js";
import { setLimits } from "./limits.js";
import { playSummary } from "./playLog.js";
import { resetSessions } from "./sessions.js";
import { clearStreamUserCache } from "./streamUser.js";

// moonlight-web-stream's /api/user, answered from the cookie's session name.
const USERS: Record<string, { id: number; name: string; role: string; role_id: number }> = {
  alice: { id: 1, name: "Alice", role: "User", role_id: 2 },
  bob: { id: 2, name: "Bob", role: "User", role_id: 2 },
  boss: { id: 9, name: "Boss", role: "Admin", role_id: 1 },
};
const realFetch = globalThis.fetch;

before(() => {
  initDb(":memory:");
  globalThis.fetch = (async (_url: string, init?: { headers?: Record<string, string> }) => {
    const session = /mlSession=(\w+)/.exec(init?.headers?.cookie ?? "")?.[1] ?? "";
    const user = USERS[session];
    return new Response(user ? JSON.stringify(user) : "", { status: user ? 200 : 401 });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  resetSessions();
  clearStreamUserCache();
  getDb().exec("DELETE FROM user_access; DELETE FROM play_sessions;");
});
afterEach(() => mock.timers.reset());

function request(session: string, url = "/stream/api/apps?host_id=7", upgrade = false) {
  return {
    method: "GET",
    url,
    headers: { cookie: `mlSession=${session}`, ...(upgrade ? { upgrade: "websocket" } : {}) },
    raw: { socket: {} },
  } as unknown as FastifyRequest;
}

/** Runs an app list through the proxy's filter; returns what the browser got. */
async function appList(session: string): Promise<string[]> {
  const body = JSON.stringify({ apps: [{ app_id: 1, title: "ES-DE" }, { app_id: 2, title: "Steam Big Picture" }, { app_id: 3, title: "Desktop" }] });
  let sent = "";
  const reply = { removeHeader() {}, send(b: unknown) { sent = String(b); } } as unknown as FastifyReply;
  await filterAppList(request(session), reply, { stream: Readable.from([Buffer.from(body)]) });
  return (JSON.parse(sent).apps as { title: string }[]).map((a) => a.title);
}

/** Opens a stream WebSocket for `session` and sends its Init for app_id. */
async function openStream(session: string, appId: number) {
  const req = request(session, "/stream/api/host/stream", true);
  await rememberSocketAccess(req);
  const source = { _socket: req.raw.socket, closed: null as null | number, reason: "", close(code: number, reason = "") { this.closed = code; this.reason = reason; } };
  const target = { terminated: false, close() {}, terminate() { this.terminated = true; } };
  checkStreamInit(source, target, JSON.stringify({ Init: { host_id: 7, app_id: appId } }), false);
  return { source, target };
}

describe("app access", () => {
  it("allows everything with no rule, and only the listed apps otherwise", () => {
    assert.equal(isAppAllowed({ apps: null, settings: null }, "Anything"), true);
    assert.equal(isAppAllowed({ apps: ["ES-DE"], settings: null }, "ES-DE"), true);
    assert.equal(isAppAllowed({ apps: ["ES-DE"], settings: null }, "Desktop"), false);
    assert.equal(isAppAllowed({ apps: ["ES-DE"], settings: null }, undefined), false);
  });

  it("filters a player's app list but not an admin's", async () => {
    setAccess(1, { apps: ["ES-DE"], settings: null });
    assert.deepEqual(await appList("alice"), ["ES-DE"]);
    assert.deepEqual(await appList("bob"), ["ES-DE", "Steam Big Picture", "Desktop"]);
    setAccess(9, { apps: [], settings: null });
    assert.deepEqual(await appList("boss"), ["ES-DE", "Steam Big Picture", "Desktop"]);
  });

  it("refuses a stream for a blocked app before it starts", async () => {
    setAccess(1, { apps: ["ES-DE"], settings: null });
    await appList("alice"); // learns the app titles
    const { source, target } = await openStream("alice", 3);
    assert.equal(source.closed, 4003);
    assert.equal(target.terminated, true);
  });

  it("refuses a second player's stream while the PC is in use", async () => {
    await appList("alice");
    const first = await openStream("alice", 1);
    assert.equal(first.source.closed, null);
    const second = await openStream("bob", 1);
    assert.equal(second.source.closed, 4009);
    const boss = await openStream("boss", 1);
    assert.equal(boss.source.closed, null, "admins take over");
  });
});

describe("play log", () => {
  it("records who played what, and for how long", async () => {
    mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
    await appList("alice");
    const { source } = await openStream("alice", 2);
    mock.timers.tick(30 * 60_000);
    streamClosed(source);
    const summary = playSummary(1);
    assert.equal(summary.sessions.length, 1);
    assert.equal(summary.sessions[0].app, "Steam Big Picture");
    assert.equal(summary.sessions[0].user, "Alice");
    assert.equal(summary.byUser[0].ms, 30 * 60_000);
  });

  it("continues the same row after a quick reconnect", async () => {
    mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
    await appList("alice");
    const a = await openStream("alice", 1);
    mock.timers.tick(10 * 60_000);
    streamClosed(a.source);
    mock.timers.tick(30_000);
    const b = await openStream("alice", 1);
    mock.timers.tick(10 * 60_000);
    streamClosed(b.source);
    const summary = playSummary(1);
    assert.equal(summary.sessions.length, 1);
    assert.equal(summary.byApp[0].ms, 20 * 60_000 + 30_000);
  });
});

describe("time limits in the proxy", () => {
  it("refuses a stream when the time is used up, and ends one that runs out", async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 30, 10, 0, 0).getTime() });
    setLimits(1, { dailyMinutes: 30 });
    await appList("alice");
    const first = await openStream("alice", 1);
    assert.equal(first.source.closed, null);
    mock.timers.tick(29 * 60_000);
    enforceTimeLimits();
    assert.equal(first.source.closed, null, "a minute left");
    mock.timers.tick(2 * 60_000);
    enforceTimeLimits();
    assert.equal(first.source.closed, 4012);
    assert.match(first.source.reason, /today/);
    const again = await openStream("alice", 1);
    assert.equal(again.source.closed, 4012, "can't start another today");
  });
});

describe("stream socket keepalive", () => {
  it("pings every stream socket until it closes, so tunnels don't drop it", () => {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
      let pings = 0;
      const source = { ping: () => pings++, close() {} };
      streamSocketOpened(source);
      streamSocketOpened(source);
      mock.timers.tick(25_000);
      assert.equal(pings, 1, "one timer per socket");
      mock.timers.tick(50_000);
      assert.equal(pings, 3);
      streamClosed(source);
      mock.timers.tick(100_000);
      assert.equal(pings, 3, "stops once closed");
    } finally {
      mock.timers.reset();
    }
  });
});
