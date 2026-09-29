import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { initDb } from "../db/index.js";
import { sendMessage } from "./messages.js";
import { registerPollRoutes } from "./routes/poll.js";
import { requestHandover, resetSessions, streamStarted } from "./sessions.js";
import { clearStreamUserCache } from "./streamUser.js";

// moonlight-web-stream's /api/user, answered from the cookie.
const realFetch = globalThis.fetch;
const USERS: Record<string, { id: number; name: string; role: string; role_id: number }> = {
  alice: { id: 1, name: "Alice", role: "User", role_id: 2 },
  bob: { id: 2, name: "Bob", role: "User", role_id: 2 },
};

let app: FastifyInstance;

before(async () => {
  initDb(":memory:");
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const cookie = (init?.headers as Record<string, string> | undefined)?.cookie ?? "";
    const who = Object.keys(USERS).find((k) => cookie.includes(`mlSession=${k}`));
    return who ? Response.json(USERS[who]) : new Response("", { status: 401 });
  }) as typeof fetch;
  app = Fastify();
  await registerPollRoutes(app);
});
after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
});
beforeEach(() => {
  resetSessions();
  clearStreamUserCache();
});

const poll = (who: string | null, query: string) =>
  app.inject({ method: "GET", url: `/api/poll?${query}`, headers: who ? { cookie: `mlSession=${who}` } : {} });

describe("/api/poll", () => {
  it("says 401 when not signed in", async () => {
    assert.equal((await poll(null, "parts=messages")).statusCode, 401);
  });

  it("answers only the parts asked for, each as its own route would", async () => {
    streamStarted({ close() {} }, { id: 1, name: "Alice", roleId: 2, admin: false });
    requestHandover({ id: 2, name: "Bob", roleId: 2, admin: false });
    const res = await poll("alice", "parts=inbox,people,coop&pads=1");
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), ["coop", "inbox", "people"]);
    assert.equal(body.inbox.requests[0].from, "Bob");
    assert.ok(Array.isArray(body.people.people));
    assert.deepEqual(body.coop.invites, []);
  });

  it("hands each message over once", async () => {
    sendMessage(2, { id: 1, name: "Alice", roleId: 2, admin: false }, "hi Bob");
    const first = (await poll("bob", "parts=messages")).json();
    assert.equal(first.messages.messages[0].text, "hi Bob");
    const second = (await poll("bob", "parts=messages")).json();
    assert.deepEqual(second.messages.messages, []);
  });
});
