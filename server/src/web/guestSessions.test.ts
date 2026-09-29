import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDb, initDb } from "../db/index.js";
import { GUEST_IDLE_MS, checkGuestSession, resetGuestSessions } from "./guestSessions.js";
import { clearStreamUserCache } from "./streamUser.js";

// moonlight-web-stream: who each session is, and logouts.
const realFetch = globalThis.fetch;
let logouts: string[] = [];
const USERS: Record<string, { id: number; name: string; role: string; role_id: number }> = {
  guest: { id: 50, name: "Sam (guest)", role: "Guest", role_id: 3 },
  member: { id: 7, name: "Ben", role: "User", role_id: 2 },
};

before(() => {
  initDb(":memory:");
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const cookie = (init?.headers as Record<string, string> | undefined)?.cookie ?? "";
    if (String(url).endsWith("/api/logout")) {
      logouts.push(cookie);
      return new Response(null, { status: 200 });
    }
    const who = Object.keys(USERS).find((k) => cookie.includes(`mlSession=${k}`));
    return who ? Response.json(USERS[who]) : new Response("", { status: 401 });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  logouts = [];
  resetGuestSessions();
  clearStreamUserCache();
  getDb().exec("DELETE FROM guest_links");
});

function guestLink(expiresAt: number, revokedAt: number | null = null) {
  getDb()
    .prepare(
      `INSERT INTO guest_links (token, name, mode, user_id, user_name, password, minutes, expires_at, created_by_id, created_by, created_at, revoked_at)
       VALUES ('t', 'Sam', 'play', 50, 'Sam (guest)', 'x', NULL, ?, 1, 'Luma', 0, ?)`
    )
    .run(expiresAt, revokedAt);
}

const T0 = 5_000_000_000_000;

describe("guest sessions", () => {
  it("carry on while they're used", async () => {
    guestLink(T0 + 24 * 3_600_000);
    assert.equal(await checkGuestSession("mlSession=guest", T0), "ok");
    assert.equal(await checkGuestSession("mlSession=guest", T0 + GUEST_IDLE_MS - 1000), "ok");
    assert.equal(await checkGuestSession("mlSession=guest", T0 + 2 * GUEST_IDLE_MS - 2000), "ok");
    assert.deepEqual(logouts, []);
  });

  it("end after being left unused, and sign them out of moonlight-web-stream", async () => {
    guestLink(T0 + 24 * 3_600_000);
    assert.equal(await checkGuestSession("mlSession=guest", T0), "ok");
    clearStreamUserCache();
    assert.equal(await checkGuestSession("mlSession=guest", T0 + GUEST_IDLE_MS + 1000), "ended");
    assert.deepEqual(logouts, ["mlSession=guest"]);
  });

  it("end as soon as the link has expired or been turned off", async () => {
    guestLink(T0 - 1);
    assert.equal(await checkGuestSession("mlSession=guest", T0), "ended");
    getDb().exec("DELETE FROM guest_links");
    guestLink(T0 + 3_600_000, T0 - 5);
    clearStreamUserCache();
    assert.equal(await checkGuestSession("mlSession=guest", T0), "ended");
  });

  it("never touch real accounts", async () => {
    assert.equal(await checkGuestSession("mlSession=member", T0), "ok");
    assert.equal(await checkGuestSession("mlSession=member", T0 + 30 * GUEST_IDLE_MS), "ok");
    assert.deepEqual(logouts, []);
  });
});
