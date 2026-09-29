import { afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { getDb, initDb } from "../db/index.js";
import { setSetting } from "../config/settings.js";
import { applyEvent, resetGames } from "./games.js";
import { notify, resetNotify } from "./notify.js";
import { playEnded, playStarted } from "./playLog.js";
import { resetSessions, streamStarted } from "./sessions.js";
import { isoWeek, resetWatchdog, watchSunshine, weeklySummary } from "./watchdog.js";

const T0 = 2_000_000_000_000;
before(() => initDb(":memory:"));
beforeEach(() => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  resetSessions();
  resetWatchdog();
  resetGames();
  resetNotify();
  getDb().exec("DELETE FROM play_sessions; DELETE FROM game_plays;");
});
afterEach(() => mock.timers.reset());

describe("Sunshine watchdog", () => {
  it("restarts only after 3 stuck checks in a row, with nobody streaming, then not again for a while", async () => {
    let restarts = 0;
    const restart = async () => void restarts++;
    const hung = async () => ({ hung: true });
    mock.timers.tick(60_000); // nobody has streamed since startup
    assert.equal(await watchSunshine(hung, restart), "hung");
    assert.equal(await watchSunshine(async () => ({ hung: false }), restart), "ok"); // resets the count
    assert.equal(await watchSunshine(hung, restart), "hung");
    assert.equal(await watchSunshine(hung, restart), "hung");
    assert.equal(await watchSunshine(hung, restart), "restarted");
    assert.equal(restarts, 1);
    for (let i = 0; i < 3; i++) await watchSunshine(hung, restart);
    assert.equal(restarts, 1); // cooling down
  });

  it("leaves a stuck Sunshine alone while someone streams", async () => {
    streamStarted({ close() {} }, { id: 1, name: "Alice", roleId: 2, admin: false });
    for (let i = 0; i < 2; i++) await watchSunshine(async () => ({ hung: true }), async () => {});
    assert.equal(await watchSunshine(async () => ({ hung: true }), async () => assert.fail("restarted")), "waiting");
  });
});

describe("weekly summary", () => {
  it("lists who played how long, and their top games", () => {
    const id = playStarted(1, "Alice", "ES-DE", T0 - 3 * 3_600_000);
    playEnded(id, T0 - 3_600_000);
    applyEvent({ event: "start", id: "a", at: T0 - 3 * 3_600_000 + 60_000, name: "FIFA 23" }, false);
    applyEvent({ event: "end", id: "a", at: T0 - 3 * 3_600_000 + 60_000 + 90 * 60_000 }, false);
    const text = weeklySummary(T0)!;
    assert.match(text, /2\.0 h played by 1 person/);
    assert.match(text, /\*\*Alice\*\* 2\.0 h \(FIFA 23 1\.5 h\)/);
  });

  it("says nothing for a week nobody played", () => {
    assert.equal(weeklySummary(T0), null);
  });

  it("numbers weeks the ISO way", () => {
    assert.equal(isoWeek(new Date(2026, 8, 28)), "2026-W40");
    assert.equal(isoWeek(new Date(2027, 0, 1)), "2026-W53");
  });
});

describe("Discord notifications", () => {
  it("sends nothing without a webhook, and throttles repeats", async () => {
    const posts: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)).content);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      setSetting("discordWebhookUrl", "");
      assert.equal(await notify("hi"), false);
      setSetting("discordWebhookUrl", "https://discord.com/api/webhooks/123/abc-DEF_1");
      assert.equal(await notify("Alice started playing", "start:Alice", 60_000), true);
      assert.equal(await notify("Alice started playing", "start:Alice", 60_000), false);
      mock.timers.tick(61_000);
      assert.equal(await notify("Alice started playing", "start:Alice", 60_000), true);
      assert.deepEqual(posts, ["Alice started playing", "Alice started playing"]);
    } finally {
      globalThis.fetch = realFetch;
      setSetting("discordWebhookUrl", "");
    }
  });
});
