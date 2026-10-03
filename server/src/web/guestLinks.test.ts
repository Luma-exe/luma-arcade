import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { getDb, initDb } from "../db/index.js";
import { setSetting } from "../config/settings.js";
import { timeLeft } from "./limits.js";
import { getAccess } from "./access.js";
import { playEnded, playStarted } from "./playLog.js";
import { registerGuestLinkRoutes } from "./routes/guestLinks.js";
import { recordStream, resetSessions, streamStarted, decide } from "./sessions.js";
import { clearStreamUserCache } from "./streamUser.js";
import { takeQueuedLaunch } from "./games.js";
import { gameStreams } from "./routes/games.js";

// A stand-in moonlight-web-stream: who each cookie is, user create/delete,
// and login (which hands out a cookie for the new account).
const accounts = new Map<number, { name: string; password: string }>();
const calls: string[] = [];
let nextUserId = 500;
const realFetch = globalThis.fetch;
const ADMIN = "mlSession=admin";

function fakeMoonlight(url: string, init?: RequestInit): Response {
  const u = new URL(url);
  const method = init?.method ?? "GET";
  const cookie = (init?.headers as Record<string, string> | undefined)?.cookie ?? "";
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  calls.push(`${method} ${u.pathname}`);
  if (u.pathname.endsWith("/api/user") && method === "GET") {
    if (cookie.includes("mlSession=admin")) return Response.json({ id: 1, name: "admin", role: "Admin", role_id: 9 });
    const m = /mlSession=u(\d+)/.exec(cookie);
    if (m && accounts.has(Number(m[1]))) return Response.json({ id: Number(m[1]), name: accounts.get(Number(m[1]))!.name, role: "Guest", role_id: 2 });
    return new Response("", { status: 401 });
  }
  if (u.pathname.endsWith("/api/user") && method === "POST") {
    if (!cookie.includes("mlSession=admin")) return new Response("", { status: 403 });
    const id = nextUserId++;
    accounts.set(id, { name: body.name, password: body.password });
    return Response.json({ id, name: body.name });
  }
  if (u.pathname.endsWith("/api/user") && method === "DELETE") {
    accounts.delete(body.id);
    return new Response("", { status: 200 });
  }
  if (u.pathname.endsWith("/api/login")) {
    const hit = [...accounts].find(([, a]) => a.name === body.name && a.password === body.password);
    if (!hit) return new Response("", { status: 401 });
    return new Response("", { status: 200, headers: { "set-cookie": `mlSession=u${hit[0]}; Path=/stream; HttpOnly` } });
  }
  return new Response("", { status: 404 });
}

let app: FastifyInstance;

before(async () => {
  initDb(":memory:");
  const dir = mkdtempSync(path.join(tmpdir(), "luma-guest-"));
  mkdirSync(path.join(dir, "server"));
  writeFileSync(
    path.join(dir, "server", "data.json"),
    JSON.stringify({ users: {}, hosts: {}, roles: { "2": { name: "Guest", ty: "User" }, "9": { name: "Admin", ty: "Admin" } } })
  );
  setSetting("moonlightWebStreamPath", path.join(dir, "web-server.exe"));
  globalThis.fetch = (async (url: string, init?: RequestInit) => fakeMoonlight(String(url), init)) as typeof fetch;
  app = Fastify();
  await registerGuestLinkRoutes(app);
});
after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
});
beforeEach(() => {
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date(2026, 8, 30, 12, 0, 0).getTime() });
  resetSessions();
  clearStreamUserCache();
  getDb().exec("DELETE FROM guest_links; DELETE FROM play_sessions; DELETE FROM user_access; DELETE FROM game_plays; DELETE FROM settings WHERE key = 'guestLinkDefaults';");
  calls.length = 0;
});
afterEach(() => mock.timers.reset());

async function create(body: object) {
  const res = await app.inject({ method: "POST", url: "/api/admin/guest-links", headers: { cookie: ADMIN }, payload: body });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { id: number; path: string; userId: number; state: string; remainingMs: number };
}

describe("guest links", () => {
  it("only admins can make one", async () => {
    const res = await app.inject({ method: "POST", url: "/api/admin/guest-links", payload: { name: "Sam" } });
    assert.equal(res.statusCode, 401);
  });

  it("makes an account and signs the visitor in as it", async () => {
    const link = await create({ name: "Sam", minutes: 60, hours: 24 });
    assert.equal(link.state, "unused");
    assert.ok(accounts.has(link.userId));
    assert.match(accounts.get(link.userId)!.name, /^Sam \(guest/);
    const res = await app.inject({ method: "GET", url: link.path });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, "/stream/");
    assert.match(String(res.headers["set-cookie"]), new RegExp(`mlSession=u${link.userId}`));
  });

  it("gives the link's play time as the guest's time left", async () => {
    const link = await create({ name: "Sam", minutes: 60, hours: 24 });
    const guest = { id: link.userId, name: "Sam (guest)", roleId: 2, admin: false };
    const row = playStarted(link.userId, "Sam (guest)", "ES-DE");
    mock.timers.tick(45 * 60_000);
    playEnded(row);
    assert.equal(timeLeft(guest).remainingMs, 15 * 60_000);
    const more = await app.inject({ method: "PATCH", url: `/api/admin/guest-links/${link.id}`, headers: { cookie: ADMIN }, payload: { minutes: 120 } });
    assert.equal(more.statusCode, 200);
    assert.equal(timeLeft(guest).remainingMs, 75 * 60_000);
  });

  it("stops working once it expires", async () => {
    const link = await create({ name: "Sam", hours: 1 });
    mock.timers.tick(2 * 3_600_000);
    const res = await app.inject({ method: "GET", url: link.path });
    assert.equal(res.statusCode, 410);
    assert.match(res.body, /expired/);
  });

  it("revoking deletes the account and ends the link", async () => {
    const link = await create({ name: "Sam", hours: 5 });
    const res = await app.inject({ method: "POST", url: `/api/admin/guest-links/${link.id}/revoke`, headers: { cookie: ADMIN } });
    assert.equal(res.statusCode, 200);
    assert.equal(accounts.has(link.userId), false);
    const open = await app.inject({ method: "GET", url: link.path });
    assert.equal(open.statusCode, 410);
  });

  it("refuses made-up tokens", async () => {
    const res = await app.inject({ method: "GET", url: "/g/not-a-real-token-at-all" });
    assert.equal(res.statusCode, 404);
  });

  it("a player-2 link joins the creator's game while they play", async () => {
    const link = await create({ name: "Pal", mode: "coop", hours: 5 });
    // Not playing yet: nothing to join.
    const early = await app.inject({ method: "GET", url: link.path });
    assert.equal(early.statusCode, 409);
    const admin = { id: 1, name: "admin", roleId: 9, admin: true };
    streamStarted({ close() {} }, admin);
    recordStream(admin, { hostId: 7, appId: 3, width: 2560, height: 1440, fps: 120 });
    const res = await app.inject({ method: "GET", url: link.path });
    assert.equal(res.statusCode, 302);
    assert.match(String(res.headers.location), /stream\.html\?hostId=7&appId=3&coop=/);
    const d = decide({ id: link.userId, name: "Pal (guest)", roleId: 2, admin: false });
    assert.equal(d.guest, true);
  });

  describe("opening straight into a game", () => {
    const realFind = gameStreams.find;
    after(() => (gameStreams.find = realFind));

    function played(title: string, rom: string | null) {
      return Number(
        getDb()
          .prepare("INSERT INTO game_plays (launch_id, user_id, user_name, app, title, system, rom, started_at) VALUES (?, 1, 'admin', 'ES-DE', ?, 'steam', ?, ?)")
          .run(`l-${title}-${Math.random()}`, title, rom, Date.now()).lastInsertRowid
      );
    }

    it("goes into the game's stream and starts it once that's up", async () => {
      gameStreams.find = async () => ({ hostId: 4, appId: 11 });
      const gameId = played("Portal 2", "C:\Games\ROMs\steam\Portal 2.url");
      const link = (await create({ name: "Sam", hours: 5, gameId })) as Awaited<ReturnType<typeof create>> & { game: { title: string } };
      assert.equal(link.game.title, "Portal 2");
      const res = await app.inject({ method: "GET", url: link.path });
      assert.equal(res.statusCode, 302);
      assert.equal(res.headers.location, "/stream/stream.html?hostId=4&appId=11&continue=1");
      assert.equal(takeQueuedLaunch(link.userId)?.title, "Portal 2");
      // Only once.
      assert.equal(takeQueuedLaunch(link.userId), null);
    });

    it("lets them start the game's app even when their apps are limited", async () => {
      const gameId = played("Portal 2", "C:\Games\ROMs\steam\Portal 2.url");
      const link = await create({ name: "Sam", hours: 5, gameId, apps: ["Desktop"] });
      assert.deepEqual(getAccess(link.userId).apps, ["Desktop", "ES-DE"]);
    });

    it("lands in the arcade when the game's app is gone", async () => {
      gameStreams.find = async () => null;
      const link = await create({ name: "Sam", hours: 5, gameId: played("Portal 2", "C:\Games\ROMs\steam\Portal 2.url") });
      const res = await app.inject({ method: "GET", url: link.path });
      assert.equal(res.headers.location, "/stream/");
      assert.equal(takeQueuedLaunch(link.userId), null);
    });

    it("refuses a game that can't be started again", async () => {
      const res = await app.inject({ method: "POST", url: "/api/admin/guest-links", headers: { cookie: ADMIN }, payload: { name: "Sam", gameId: played("Menu", null) } });
      assert.equal(res.statusCode, 400);
    });
  });

  it("lists links with their state for admins", async () => {
    await create({ name: "Sam", hours: 5 });
    const res = await app.inject({ method: "GET", url: "/api/admin/guest-links", headers: { cookie: ADMIN } });
    assert.equal(res.statusCode, 200);
    const { links } = res.json() as { links: { name: string; state: string; playing: boolean }[] };
    assert.equal(links.length, 1);
    assert.equal(links[0].name, "Sam");
    assert.equal(links[0].playing, false);
  });

  it("delivers messages once", async () => {
    const link = await create({ name: "Sam", hours: 5 });
    const send = await app.inject({ method: "POST", url: "/api/admin/messages", headers: { cookie: ADMIN }, payload: { userId: link.userId, text: "5 more minutes!" } });
    assert.equal(send.statusCode, 200);
    const opened = await app.inject({ method: "GET", url: link.path });
    const cookie = String(opened.headers["set-cookie"]).split(";")[0];
    const first = await app.inject({ method: "GET", url: "/api/messages", headers: { cookie } });
    assert.deepEqual((first.json() as { messages: { text: string }[] }).messages.map((m) => m.text), ["5 more minutes!"]);
    const second = await app.inject({ method: "GET", url: "/api/messages", headers: { cookie } });
    assert.equal((second.json() as { messages: unknown[] }).messages.length, 0);
  });

  it("turns a guest into a real account, taking their play history along", async () => {
    const link = await create({ name: "Sam", minutes: 60, hours: 5 });
    const row = playStarted(link.userId, "Sam (guest)", "ES-DE");
    mock.timers.tick(20 * 60_000);
    playEnded(row);
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/guest-links/${link.id}/convert`,
      headers: { cookie: ADMIN },
      payload: { name: "Sam", password: "hunter2", roleId: 2 },
    });
    assert.equal(res.statusCode, 200, res.body);
    const done = res.json() as { state: string; convertedTo: string };
    assert.equal(done.state, "converted");
    assert.equal(done.convertedTo, "Sam");
    // The real account exists, the guest one is gone.
    const real = [...accounts].find(([, a]) => a.name === "Sam");
    assert.ok(real);
    assert.equal(accounts.has(link.userId), false);
    // History moved to the new account.
    const rows = getDb().prepare("SELECT user_id, user_name FROM play_sessions").all() as { user_id: number; user_name: string }[];
    assert.deepEqual(rows, [{ user_id: real[0], user_name: "Sam" }]);
    // And the link no longer opens.
    assert.equal((await app.inject({ method: "GET", url: link.path })).statusCode, 410);
  });

  it("checks the new account's details, and only converts once", async () => {
    const link = await create({ name: "Sam", hours: 5 });
    const url = `/api/admin/guest-links/${link.id}/convert`;
    const weak = await app.inject({ method: "POST", url, headers: { cookie: ADMIN }, payload: { name: "Sam", password: "x", roleId: 2 } });
    assert.equal(weak.statusCode, 400);
    assert.match(weak.body, /password/);
    const noRole = await app.inject({ method: "POST", url, headers: { cookie: ADMIN }, payload: { name: "Sam", password: "hunter2", roleId: 12345 } });
    assert.equal(noRole.statusCode, 400);
    const ok = await app.inject({ method: "POST", url, headers: { cookie: ADMIN }, payload: { name: "Sam2", password: "hunter2", roleId: 2 } });
    assert.equal(ok.statusCode, 200, ok.body);
    const again = await app.inject({ method: "POST", url, headers: { cookie: ADMIN }, payload: { name: "Sam3", password: "hunter2", roleId: 2 } });
    assert.equal(again.statusCode, 400);
    assert.match(again.body, /already became/);
  });

  it("only admins can convert", async () => {
    const link = await create({ name: "Sam", hours: 5 });
    const res = await app.inject({ method: "POST", url: `/api/admin/guest-links/${link.id}/convert`, payload: { name: "Sam", password: "hunter2", roleId: 2 } });
    assert.equal(res.statusCode, 401);
  });

  it("new links take the admin's defaults for apps and settings access", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/api/admin/guest-links/defaults",
      headers: { cookie: ADMIN },
      payload: { apps: ["ES-DE"], settings: ["quality", "controller"], minutes: 30, hours: 6 },
    });
    assert.equal(put.statusCode, 200, put.body);
    const got = await app.inject({ method: "GET", url: "/api/admin/guest-links/defaults", headers: { cookie: ADMIN } });
    assert.deepEqual(got.json(), { mode: "play", minutes: 30, hours: 6, apps: ["ES-DE"], settings: ["quality", "controller"] });

    const link = await create({ name: "Sam" });
    assert.deepEqual(getAccess(link.userId), { apps: ["ES-DE"], settings: ["quality", "controller"] });
    const listed = (await app.inject({ method: "GET", url: "/api/admin/guest-links", headers: { cookie: ADMIN } })).json() as {
      links: { minutes: number; access: { apps: string[] } }[];
    };
    assert.equal(listed.links[0].minutes, 30);
    assert.deepEqual(listed.links[0].access.apps, ["ES-DE"]);
  });

  it("a link's own choices beat the defaults", async () => {
    await app.inject({ method: "PUT", url: "/api/admin/guest-links/defaults", headers: { cookie: ADMIN }, payload: { apps: ["ES-DE"], settings: [] } });
    const link = await create({ name: "Sam", apps: null, settings: null });
    assert.deepEqual(getAccess(link.userId), { apps: null, settings: null });
  });

  it("player-2 links never get an app list (they join whatever is running)", async () => {
    await app.inject({ method: "PUT", url: "/api/admin/guest-links/defaults", headers: { cookie: ADMIN }, payload: { apps: ["ES-DE"], settings: ["controller"] } });
    const link = await create({ name: "Pal", mode: "coop" });
    assert.deepEqual(getAccess(link.userId), { apps: null, settings: ["controller"] });
  });

  it("rejects silly defaults", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/admin/guest-links/defaults", headers: { cookie: ADMIN }, payload: { hours: -1 } });
    assert.equal(res.statusCode, 400);
    const noAdmin = await app.inject({ method: "PUT", url: "/api/admin/guest-links/defaults", payload: { hours: 5 } });
    assert.equal(noAdmin.statusCode, 401);
  });
});
