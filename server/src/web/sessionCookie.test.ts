import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FastifyRequest } from "fastify";
import { isSecureRequest, sturdySessionCookie, sturdySetCookieHeader } from "./sessionCookie.js";

const NOW = Date.parse("2026-09-30T09:41:44Z");
const MOONLIGHT = "mlSession=abc; HttpOnly; SameSite=Strict; Secure; Path=/stream; Expires=Fri, 30 Oct 2026 09:41:44 GMT";

describe("session cookie", () => {
  it("adds Max-Age and relaxes SameSite on the session cookie", () => {
    assert.equal(
      sturdySessionCookie(MOONLIGHT, NOW),
      "mlSession=abc; HttpOnly; SameSite=Lax; Secure; Path=/stream; Expires=Fri, 30 Oct 2026 09:41:44 GMT; Max-Age=2592000",
    );
  });

  it("keeps a sign-out cookie expired", () => {
    const out = sturdySessionCookie("mlSession=; Path=/stream; Expires=Thu, 01 Jan 1970 00:00:00 GMT", NOW);
    assert.match(out, /Max-Age=0$/);
  });

  it("leaves other cookies and an existing Max-Age alone", () => {
    assert.equal(sturdySessionCookie("other=1; SameSite=Strict", NOW), "other=1; SameSite=Strict");
    assert.equal(sturdySessionCookie("mlSession=a; Max-Age=5; Expires=Fri, 30 Oct 2026 09:41:44 GMT", NOW), "mlSession=a; Max-Age=5; Expires=Fri, 30 Oct 2026 09:41:44 GMT");
  });

  it("handles a header list or none", () => {
    assert.equal(sturdySetCookieHeader(undefined), undefined);
    assert.deepEqual(sturdySetCookieHeader([MOONLIGHT], NOW), [sturdySessionCookie(MOONLIGHT, NOW)]);
  });
});

describe("Secure on https", () => {
  const PLAIN = "mlSession=abc; HttpOnly; SameSite=Strict; Path=/stream";
  const req = (remote: string, headers: Record<string, string>, protocol = "http") =>
    ({ socket: { remoteAddress: remote }, headers: { host: "arcade.example.com", ...headers }, raw: { url: "/" }, protocol }) as unknown as FastifyRequest;

  it("adds Secure only when asked, once", () => {
    assert.ok(!/Secure/.test(sturdySessionCookie(PLAIN, NOW, false)));
    assert.match(sturdySessionCookie(PLAIN, NOW, true), /; Secure$/);
    assert.equal(sturdySessionCookie(MOONLIGHT, NOW, true).match(/Secure/g)?.length, 1);
    assert.deepEqual(sturdySetCookieHeader([PLAIN, "other=1"], NOW, true), [sturdySessionCookie(PLAIN, NOW, true), "other=1"]);
  });

  it("is secure through the tunnel over https and on the https listener", () => {
    assert.equal(isSecureRequest(req("127.0.0.1", { "cf-connecting-ip": "1.2.3.4", "cf-visitor": '{"scheme":"https"}' })), true);
    assert.equal(isSecureRequest(req("192.168.1.5", {}, "https")), true);
  });

  it("is not secure on plain http", () => {
    assert.equal(isSecureRequest(req("192.168.1.5", {})), false);
    assert.equal(isSecureRequest(req("127.0.0.1", { "cf-connecting-ip": "1.2.3.4", "cf-visitor": '{"scheme":"http"}' })), false);
  });
});
