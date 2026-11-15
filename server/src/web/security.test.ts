import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { initDb } from "../db/index.js";
import { setSetting } from "../config/settings.js";
import { rateKey } from "./auth.js";
import { registerRequestHooks } from "./server.js";
import { registerMoonlightRoutes } from "./routes/moonlight.js";
import { registerHomeRoutes } from "./routes/home.js";
import { TRUSTED_PROXIES } from "./requestOrigin.js";
import { resetSessions, streamStarted } from "./sessions.js";
import { clearStreamUserCache } from "./streamUser.js";

const USERS: Record<string, { id: number; name: string; role: string; role_id: number }> = {
  alice: { id: 1, name: "Alice", role: "User", role_id: 2 },
  bob: { id: 2, name: "Bob", role: "User", role_id: 2 },
  boss: { id: 9, name: "Boss", role: "Admin", role_id: 1 },
};
const realFetch = globalThis.fetch;
let app: FastifyInstance;
let upstream: Server;
const upstreamHits: string[] = [];

before(async () => {
  initDb(":memory:");
  // A stand-in for moonlight-web-stream: logins fail with 404, the rest is
  // a page that sets its own (weaker) headers.
  upstream = createHttpServer((req, res) => {
    upstreamHits.push(`${req.method} ${req.url}`);
    if (req.url?.endsWith("/api/login")) {
      res.writeHead(404, { "content-type": "text/plain" }).end("no such user");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain", "x-frame-options": "ALLOWALL" }).end("ok");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  setSetting("moonlightWebStreamPort", (upstream.address() as AddressInfo).port);

  globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    if (!String(url).includes("/api/user")) return realFetch(url);
    const session = /mlSession=(\w+)/.exec(init?.headers?.cookie ?? "")?.[1] ?? "";
    const user = USERS[session];
    return new Response(user ? JSON.stringify(user) : "", { status: user ? 200 : 401 });
  }) as typeof fetch;

  app = Fastify({ trustProxy: TRUSTED_PROXIES });
  registerRequestHooks(app);
  await registerMoonlightRoutes(app);
  await registerHomeRoutes(app);
  await app.ready();
});
after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  upstream.close();
});
beforeEach(() => {
  upstreamHits.length = 0;
  resetSessions();
  clearStreamUserCache();
});

/** A POST with the path sent exactly as given (inject tidies dot segments away). */
function rawPost(port: number, path: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "POST" }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end("{}");
  });
}

describe("proxy gates see the path moonlight-web-stream sees", () => {
  for (const url of ["/stream/api/%6Cogin", "/stream//api/login", "/stream/api/%256Cogin", "/stream/api/%zz"]) {
    it(`refuses POST ${url}`, async () => {
      const res = await app.inject({ method: "POST", url, payload: {} });
      assert.equal(res.statusCode, 400);
      assert.deepEqual(upstreamHits, []);
    });
  }

  it("refuses dot segments in an API path as sent", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    assert.equal(await rawPost(port, "/stream/./api/login"), 400);
    assert.equal(await rawPost(port, "/stream/x/../api/host/cancel"), 400);
    assert.deepEqual(upstreamHits, []);
  });

  it("leaves odd static asset paths alone", async () => {
    const res = await app.inject({ method: "GET", url: "/stream/resources/a%20b.js?v=1" });
    assert.equal(res.statusCode, 200);
    assert.equal(upstreamHits.length, 1);
  });

  it("answers an unknown user's sign-in like a wrong password", async () => {
    const res = await app.inject({ method: "POST", url: "/stream/api/login", payload: {}, headers: { "cf-connecting-ip": "9.9.9.9" } });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: "Wrong username or password." });
  });
});

describe("security headers", () => {
  it("are on our own replies", async () => {
    const res = await app.inject({ method: "GET", url: "/api/home/nothing" });
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["referrer-policy"], "same-origin");
    assert.equal(res.headers["x-frame-options"], "SAMEORIGIN");
    assert.equal(res.headers["content-security-policy"], "frame-ancestors 'self'");
    assert.equal(res.headers["strict-transport-security"], undefined);
  });

  it("survive on proxied replies, and HSTS is only for https through the tunnel", async () => {
    const tunnel = { "cf-connecting-ip": "203.0.113.9", "cf-visitor": '{"scheme":"https"}', "x-forwarded-proto": "https" };
    const res = await app.inject({ method: "GET", url: "/stream/", headers: tunnel });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["x-frame-options"], "SAMEORIGIN");
    assert.equal(res.headers["content-security-policy"], "frame-ancestors 'self'");
    assert.equal(res.headers["strict-transport-security"], "max-age=15552000");
    // The LAN (no tunnel) never gets it: it still uses plain http on :4500.
    const lan = await app.inject({ method: "GET", url: "/stream/", headers: { "x-forwarded-proto": "https" } });
    assert.equal(lan.headers["strict-transport-security"], undefined);
  });
});

describe("cross-site writes", () => {
  const post = (headers: Record<string, string>) =>
    app.inject({ method: "POST", url: "/stream/api/thing", payload: {}, headers: { host: "arcade.example.com", ...headers } });

  it("refuses Sec-Fetch-Site: cross-site", async () => {
    assert.equal((await post({ "sec-fetch-site": "cross-site" })).statusCode, 403);
  });
  it("refuses a foreign Origin", async () => {
    assert.equal((await post({ origin: "https://evil.example" })).statusCode, 403);
    assert.equal((await post({ origin: "null" })).statusCode, 403);
  });
  it("lets the same origin and no Origin through", async () => {
    assert.equal((await post({ origin: "https://arcade.example.com" })).statusCode, 200);
    assert.equal((await post({})).statusCode, 200);
  });
  it("lets loopback names talk to each other (dev)", async () => {
    assert.equal((await post({ host: "localhost:3000", origin: "http://127.0.0.1:5173" })).statusCode, 200);
  });
  it("never blocks reads", async () => {
    const res = await app.inject({ method: "GET", url: "/stream/", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    assert.equal(res.statusCode, 200);
  });
});

describe("Home controls", () => {
  const go = (session: string) =>
    app.inject({ method: "POST", url: "/api/home/go", payload: {}, headers: { cookie: `mlSession=${session}` } });

  it("are for whoever holds the PC, or an admin", async () => {
    streamStarted({ close() {} }, { id: 1, name: "Alice", roleId: 2, admin: false });
    assert.equal((await go("bob")).statusCode, 403);
    assert.notEqual((await go("alice")).statusCode, 403);
    assert.notEqual((await go("boss")).statusCode, 403);
  });

  it("are open when nobody has the PC", async () => {
    assert.notEqual((await go("bob")).statusCode, 403);
  });
});

describe("rateKey", () => {
  it("leaves IPv4 and mapped addresses alone", () => {
    assert.equal(rateKey("203.0.113.9"), "203.0.113.9");
    assert.equal(rateKey("::ffff:203.0.113.9"), "::ffff:203.0.113.9");
  });
  it("counts an IPv6 /64 as one visitor", () => {
    assert.equal(rateKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), rateKey("2001:DB8:1:2::1"));
    assert.equal(rateKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2");
    assert.notEqual(rateKey("2001:db8:1:2::1"), rateKey("2001:db8:1:3::1"));
    // Home-network v6 addresses keep their own bucket.
    assert.equal(rateKey("::1"), "::1");
    assert.equal(rateKey("fd12:3456:789a:1::5"), "fd12:3456:789a:1::5");
    assert.notEqual(rateKey("fe80::1"), rateKey("fe80::2"));
    assert.equal(rateKey("2001:db8::1"), "2001:db8:0:0");
  });
});
