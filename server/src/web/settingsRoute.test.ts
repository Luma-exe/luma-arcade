import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { initDb } from "../db/index.js";
import { getSetting, setSetting } from "../config/settings.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerUpdateRoutes } from "./routes/update.js";

const realFetch = globalThis.fetch;
let app: FastifyInstance;
const admin = { cookie: "mlSession=admin" };

before(async () => {
  initDb(":memory:");
  // moonlight-web-stream's "who is this" (requireAdmin); GitHub has no releases.
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/api/user")) {
      const cookie = (init?.headers as Record<string, string> | undefined)?.cookie ?? "";
      return cookie.includes("mlSession=admin")
        ? Response.json({ id: 1, name: "Luma", role: "Admin", role_id: 9 })
        : new Response("", { status: 401 });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }) as typeof fetch;
  app = Fastify();
  await registerSettingsRoutes(app);
  await registerUpdateRoutes(app);
});
after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
});

const put = (payload: object) => app.inject({ method: "PUT", url: "/api/settings", headers: admin, payload });

describe("adminDiscordId setting", () => {
  it("takes digits or empty", async () => {
    assert.equal((await put({ adminDiscordId: "851332798231871508" })).statusCode, 200);
    assert.equal(getSetting("adminDiscordId"), "851332798231871508");
    assert.equal((await put({ adminDiscordId: "" })).statusCode, 200);
    assert.equal(getSetting("adminDiscordId"), "");
  });

  it("refuses anything else", async () => {
    for (const bad of ["abc", "1234", "12 345", "<@123456>", "1".repeat(26), 123456, null]) {
      assert.equal((await put({ adminDiscordId: bad })).statusCode, 400, String(bad));
    }
    assert.equal(getSetting("adminDiscordId"), "");
  });
});

describe("update routes", () => {
  it("check has the fields the settings screen reads", async () => {
    const res = await app.inject({ method: "GET", url: "/api/update/check", headers: admin });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    for (const key of ["localVersion", "latestVersion", "canApply", "downloadUrl", "updateAvailable", "latestCommit", "compareUrl"]) {
      assert.ok(key in body, key);
    }
    assert.equal(body.canApply, false);
  });

  it("apply says 409 when this install has no source tree to update from", async () => {
    setSetting("devTreePath", "");
    const res = await app.inject({ method: "POST", url: "/api/update/apply", headers: admin, remoteAddress: "192.168.1.5" });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error, /update itself/);
  });
});
