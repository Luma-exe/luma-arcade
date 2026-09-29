import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { getDb, initDb } from "../db/index.js";
import { setSetting } from "../config/settings.js";
import { resetNotify } from "./notify.js";
import { ADMIN_DISCORD_ID, forDiscord, oneLine, registerWelcomeRoutes } from "./routes/welcome.js";

const realFetch = globalThis.fetch;
let posts: { content: string; allowed_mentions: { parse: string[]; users: string[] } }[] = [];
let app: FastifyInstance;

before(async () => {
  initDb(":memory:");
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    // moonlight-web-stream's "who is this" (the admin endpoints)
    if (String(url).endsWith("/api/user")) {
      const cookie = (init?.headers as Record<string, string> | undefined)?.cookie ?? "";
      return cookie.includes("mlSession=admin")
        ? Response.json({ id: 1, name: "Luma", role: "Admin", role_id: 9 })
        : new Response("", { status: 401 });
    }
    posts.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  app = Fastify();
  await registerWelcomeRoutes(app);
});
after(async () => {
  globalThis.fetch = realFetch;
  setSetting("discordWebhookUrl", "");
  await app.close();
});
beforeEach(() => {
  posts = [];
  resetNotify();
  getDb().exec("DELETE FROM account_requests; DELETE FROM password_resets;");
  setSetting("discordWebhookUrl", "https://discord.com/api/webhooks/1/abc");
});

/** A visitor from the internet (through the tunnel) at `ip`. */
const ask = (ip: string, payload: object) =>
  app.inject({ method: "POST", url: "/api/account-request", headers: { "cf-connecting-ip": ip }, payload });

describe("welcome page", () => {
  it("is what / shows, and a / link with a query still goes to the arcade", async () => {
    const page = await app.inject({ method: "GET", url: "/" });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Request an account/);
    assert.match(page.body, /luma_exe/);
    const settings = await app.inject({ method: "GET", url: "/?view=settings" });
    assert.equal(settings.statusCode, 302);
    assert.equal(settings.headers.location, "/stream/?view=settings");
  });
});

describe("account requests", () => {
  it("pings the admin on Discord with the name, Discord and message", async () => {
    const res = await ask("203.0.113.5", { name: "Sam", contact: "sam_1", message: "Hi!\nIt's Ben's brother." });
    assert.equal(res.statusCode, 200);
    assert.equal(posts.length, 1);
    assert.match(posts[0].content, new RegExp(`^<@${ADMIN_DISCORD_ID}> 📝 \\*\\*Sam\\*\\* is asking for an arcade account`));
    // (escaped, so Discord shows the underscore instead of starting italics)
    assert.match(posts[0].content, /Discord: sam\\_1/);
    assert.match(posts[0].content, /> Hi!\n> It's Ben's brother\./);
    assert.deepEqual(posts[0].allowed_mentions, { parse: [], users: [ADMIN_DISCORD_ID] });
  });

  it("only once per visitor", async () => {
    assert.equal((await ask("203.0.113.6", { name: "Sam" })).statusCode, 200);
    const again = await ask("203.0.113.6", { name: "Sam again" });
    assert.equal(again.statusCode, 409);
    assert.equal(posts.length, 1);
    const status = await app.inject({ method: "GET", url: "/api/account-request", headers: { "cf-connecting-ip": "203.0.113.6" } });
    assert.deepEqual(status.json(), { requested: true, name: "Sam" });
  });

  it("needs a name", async () => {
    assert.equal((await ask("203.0.113.7", { name: "  " })).statusCode, 400);
    assert.equal(posts.length, 0);
  });

  it("caps everyone together so it can't be used to spam", async () => {
    for (let i = 0; i < 10; i++) assert.equal((await ask(`198.51.100.${i}`, { name: `P${i}` })).statusCode, 200);
    assert.equal((await ask("198.51.100.99", { name: "One too many" })).statusCode, 429);
  });

  it("keeps text from pinging anyone or breaking the message", () => {
    assert.equal(oneLine("  Sam\nSmith  ", 40), "Sam Smith");
    assert.equal(forDiscord("**Sam** @everyone luma_exe"), "\\*\\*Sam\\*\\* @​everyone luma\\_exe");
  });

  it("still records a request when no Discord webhook is set", async () => {
    setSetting("discordWebhookUrl", "");
    assert.equal((await ask("203.0.113.8", { name: "Sam" })).statusCode, 200);
    const row = getDb().prepare("SELECT delivered FROM account_requests").get() as { delivered: number };
    assert.equal(row.delivered, 0);
  });
});

describe("forgotten passwords", () => {
  const reset = (ip: string, payload: object) =>
    app.inject({ method: "POST", url: "/api/password-reset", headers: { "cf-connecting-ip": ip }, payload });

  it("pings the admin with the account name, Discord and message", async () => {
    const res = await reset("203.0.113.20", { name: "Ben", contact: "ben_2", message: "New phone, lost it" });
    assert.equal(res.statusCode, 200);
    assert.ok(posts[0].content.startsWith(`<@${ADMIN_DISCORD_ID}> 🔑 **Ben** forgot their arcade password`), posts[0].content);
    assert.match(posts[0].content, /Discord: ben\\_2/);
    assert.match(posts[0].content, /> New phone, lost it/);
    assert.deepEqual(posts[0].allowed_mentions.users, [ADMIN_DISCORD_ID]);
  });

  it("once a day per visitor", async () => {
    assert.equal((await reset("203.0.113.21", { name: "Ben" })).statusCode, 200);
    assert.equal((await reset("203.0.113.21", { name: "Ben" })).statusCode, 409);
    const status = await app.inject({ method: "GET", url: "/api/password-reset", headers: { "cf-connecting-ip": "203.0.113.21" } });
    assert.ok(status.json().requestedAt);
    // a day later they may ask again
    getDb().prepare("UPDATE password_resets SET created_at = created_at - 25 * 3600000").run();
    assert.equal((await reset("203.0.113.21", { name: "Ben" })).statusCode, 200);
  });

  it("needs the account name", async () => {
    assert.equal((await reset("203.0.113.22", { name: "" })).statusCode, 400);
  });
});

describe("the admin's Requests tab", () => {
  const admin = { cookie: "mlSession=admin" };

  it("lists account and password requests, newest first, and marks them done", async () => {
    await ask("203.0.113.30", { name: "Sam", contact: "sam_1", message: "hi" });
    await app.inject({ method: "POST", url: "/api/password-reset", headers: { "cf-connecting-ip": "203.0.113.31" }, payload: { name: "Ben" } });
    const list = await app.inject({ method: "GET", url: "/api/admin/requests", headers: admin });
    assert.equal(list.statusCode, 200);
    const body = list.json();
    assert.equal(body.accounts[0].name, "Sam");
    assert.equal(body.accounts[0].contact, "sam_1");
    assert.equal(body.accounts[0].handledAt, null);
    assert.equal(body.resets[0].name, "Ben");
    const done = await app.inject({ method: "POST", url: `/api/admin/requests/account/${body.accounts[0].id}`, headers: admin, payload: { handled: true } });
    assert.equal(done.statusCode, 200);
    const after = (await app.inject({ method: "GET", url: "/api/admin/requests", headers: admin })).json();
    assert.ok(after.accounts[0].handledAt);
    assert.equal(after.accounts[0].handledBy, "Luma");
  });

  it("is admins only", async () => {
    assert.equal((await app.inject({ method: "GET", url: "/api/admin/requests" })).statusCode, 401);
  });
});
