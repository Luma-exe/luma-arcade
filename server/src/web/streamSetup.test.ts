import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { getDb, initDb } from "../db/index.js";
import { registerStreamSetupRoutes } from "./routes/streamSetup.js";
import { cleanSetupSettings, copyStreamSetup, getStreamSetup } from "./streamSetup.js";
import { clearStreamUserCache } from "./streamUser.js";

const realFetch = globalThis.fetch;
let app: FastifyInstance;

before(async () => {
  initDb(":memory:");
  // moonlight-web-stream's "who is this": mlSession=<id> is user <id>
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const cookie = (init?.headers as Record<string, string> | undefined)?.cookie ?? "";
    const m = /mlSession=(\d+)/.exec(cookie);
    return m ? Response.json({ id: Number(m[1]), name: `P${m[1]}`, role: "User", role_id: 2 }) : new Response("", { status: 401 });
  }) as typeof fetch;
  app = Fastify();
  await registerStreamSetupRoutes(app);
});
after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
});
beforeEach(() => {
  getDb().exec("DELETE FROM user_prefs;");
  clearStreamUserCache();
});

const as = (id: number) => ({ cookie: `mlSession=${id}` });

describe("stream setup", () => {
  it("isn't done for someone new", async () => {
    const res = await app.inject({ method: "GET", url: "/api/me/stream-setup", headers: as(5) });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { done: false, mode: null, settings: null, at: null });
  });

  it("needs a sign-in", async () => {
    const res = await app.inject({ method: "GET", url: "/api/me/stream-setup" });
    assert.equal(res.statusCode, 401);
  });

  it("saves once: a second setup is refused and the first one stays", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/me/stream-setup",
      headers: as(5),
      payload: { mode: "static", settings: { bitrate: 18000, fps: 60, videoSize: "1080p", videoCodec: "h265", videoFrameQueueSize: 3 }, measure: { mbps: 42.3 } },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().done, true);
    assert.deepEqual(first.json().settings, { autoQuality: false, bitrate: 18000, fps: 60, videoSize: "1080p", videoCodec: "h265", videoFrameQueueSize: 3 });

    const again = await app.inject({ method: "POST", url: "/api/me/stream-setup", headers: as(5), payload: { mode: "auto", settings: {} } });
    assert.equal(again.statusCode, 409);
    assert.equal(getStreamSetup(5).mode, "static");
    // Someone else still gets asked
    assert.equal(getStreamSetup(6).done, false);
  });

  it("can be run again from Settings, which replaces it", async () => {
    await app.inject({ method: "POST", url: "/api/me/stream-setup", headers: as(5), payload: { mode: "static", settings: { bitrate: 18000 } } });
    const firstAt = getStreamSetup(5).at!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const redo = await app.inject({ method: "POST", url: "/api/me/stream-setup", headers: as(5), payload: { mode: "auto", redo: true, settings: { videoFrameQueueSize: 2 } } });
    assert.equal(redo.statusCode, 200);
    assert.deepEqual(getStreamSetup(5).settings, { autoQuality: true, videoFrameQueueSize: 2 });
    // A new time, so other browsers take the new settings too
    assert.ok(getStreamSetup(5).at! > firstAt);
  });

  it("keeps a player's other preferences", async () => {
    getDb().prepare("INSERT INTO user_prefs (user_id, share_playing, updated_at) VALUES (5, 1, 1)").run();
    await app.inject({ method: "POST", url: "/api/me/stream-setup", headers: as(5), payload: { mode: "auto" } });
    const row = getDb().prepare("SELECT share_playing FROM user_prefs WHERE user_id = 5").get() as { share_playing: number };
    assert.equal(row.share_playing, 1);
    assert.equal(getStreamSetup(5).settings?.autoQuality, true);
  });

  it("refuses an unknown mode", async () => {
    const res = await app.inject({ method: "POST", url: "/api/me/stream-setup", headers: as(5), payload: { mode: "turbo" } });
    assert.equal(res.statusCode, 400);
    assert.equal(getStreamSetup(5).done, false);
  });

  it("keeps only known, sensible settings", () => {
    assert.deepEqual(
      cleanSetupSettings("static", { bitrate: 1e9, fps: 60.5, videoSize: "8k", videoCodec: "h265", autoQuality: true, cookieSecret: "x" }),
      { autoQuality: false, videoCodec: "h265" }
    );
  });

  it("goes with a guest who becomes an account", async () => {
    await app.inject({ method: "POST", url: "/api/me/stream-setup", headers: as(7), payload: { mode: "auto", settings: { videoFrameQueueSize: 2 } } });
    copyStreamSetup(7, 8);
    assert.deepEqual(getStreamSetup(8).settings, { autoQuality: true, videoFrameQueueSize: 2 });
    copyStreamSetup(9, 10); // nothing to copy
    assert.equal(getStreamSetup(10).done, false);
  });
});
