import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { initDb } from "../db/index.js";
import { registerUpdatesRoutes } from "./routes/updates.js";
import { countUpdates, rowFromComponent, updatesKey } from "../updates/index.js";

const realFetch = globalThis.fetch;
let app: FastifyInstance;

before(async () => {
  initDb(":memory:");
  // moonlight-web-stream's "who is this": nobody is signed in.
  globalThis.fetch = (async () => new Response("", { status: 401 })) as typeof fetch;
  app = Fastify();
  await registerUpdatesRoutes(app);
});
after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
});

describe("updates window", () => {
  it("serves the page, never cached", async () => {
    const res = await app.inject({ method: "GET", url: "/updates/" });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /<title>Luma Arcade · Updates<\/title>/);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal((await app.inject({ method: "GET", url: "/updates" })).statusCode, 302);
  });

  it("needs the tray's key or a signed-in admin", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/api/updates/job" })).statusCode, 401);
    const wrong = await app.inject({ method: "GET", url: "/api/updates/job", headers: { "x-updates-key": "nope" } });
    assert.equal(wrong.statusCode, 401);
    const right = await app.inject({ method: "GET", url: "/api/updates/job", headers: { "x-updates-key": updatesKey } });
    assert.equal(right.statusCode, 200);
    assert.equal(right.json().running, false);
  });

  it("refuses the internet, even with the key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/updates/job",
      headers: { "x-updates-key": updatesKey, "cf-connecting-ip": "203.0.113.9" },
    });
    assert.equal(res.statusCode, 403);
  });

  it("wants something to update", async () => {
    const headers = { "x-updates-key": updatesKey };
    for (const payload of [{}, { ids: [] }, { ids: ["../../x", "A B", 5] }]) {
      const res = await app.inject({ method: "POST", url: "/api/updates/apply", headers, payload });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
    }
  });
});

describe("update rows", () => {
  const base = { id: "dolphin", name: "Dolphin", what: "GameCube, Wii", group: "Emulators", installed: "2609", busy: null, note: null };

  it("turns the script's comparison into a state", () => {
    assert.equal(rowFromComponent({ ...base, target: "2611", compare: "older" }).state, "new");
    assert.equal(rowFromComponent({ ...base, target: "2609", compare: "same" }).state, "ok");
    assert.equal(rowFromComponent({ ...base, target: "2509", compare: "newer" }).state, "ok");
    assert.equal(rowFromComponent({ ...base, target: "2611", compare: "unknown" }).state, "unknown");
    assert.equal(rowFromComponent({ ...base, error: "offline" }).state, "error");
  });

  it("keeps busy programs as a list", () => {
    assert.deepEqual(rowFromComponent({ ...base, busy: "Dolphin" }).busy, ["Dolphin"]);
    assert.deepEqual(rowFromComponent({ ...base, busy: ["ES-DE", "Dolphin"] }).busy, ["ES-DE", "Dolphin"]);
    assert.deepEqual(rowFromComponent(base).busy, []);
  });

  it("counts what's ready for the tray", () => {
    const rows = [
      rowFromComponent({ ...base, target: "2611", compare: "older" }),
      rowFromComponent({ ...base, id: "pcsx2", target: "2.8.2", compare: "older" }),
      rowFromComponent({ ...base, id: "cemu", target: "2.6", compare: "same" }),
    ];
    assert.equal(countUpdates({ mode: "tested", checkedAt: null, rows }), 2);
    assert.equal(countUpdates(null), 0);
  });
});
