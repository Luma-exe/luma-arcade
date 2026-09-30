import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sturdySessionCookie, sturdySetCookieHeader } from "./sessionCookie.js";

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
