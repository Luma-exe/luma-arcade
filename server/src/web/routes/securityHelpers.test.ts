import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickKnownSettings } from "./settings.js";
import { recordSaveAction, resetSavesThrottle, throttleWait } from "./saves.js";
import { MAX_CONCURRENT_DOWNLOADS, takeDownloadSlot } from "./speedtest.js";
import { serialize } from "../profilesScript.js";

describe("settings keys", () => {
  it("keeps real settings and drops __proto__, constructor and toString", () => {
    const current = { port: 3000, autoStart: false };
    const body = JSON.parse('{"port":4000,"__proto__":{"x":1},"constructor":1,"toString":2,"cookieSecret":"x"}');
    assert.deepEqual(Object.keys(pickKnownSettings(body, current)), ["port"]);
  });
});

describe("saves throttle", () => {
  it("makes a player wait between snapshots, per player and action", () => {
    resetSavesThrottle();
    assert.equal(throttleWait(1, "snapshot", 1000), 0);
    recordSaveAction(1, "snapshot", 1000);
    assert.equal(throttleWait(1, "snapshot", 11_000), 20);
    assert.equal(throttleWait(2, "snapshot", 11_000), 0);
    assert.equal(throttleWait(1, "list", 11_000), 0);
    assert.equal(throttleWait(1, "snapshot", 31_000), 0);
    recordSaveAction(1, "list", 13_000);
    assert.equal(throttleWait(1, "list", 13_500), 1);
    assert.equal(throttleWait(1, "list", 14_000), 0);
  });
  it("doesn't count a run that wasn't recorded (it failed)", () => {
    resetSavesThrottle();
    assert.equal(throttleWait(1, "restore", 1000), 0);
    assert.equal(throttleWait(1, "restore", 1500), 0);
  });
});

describe("speedtest slots", () => {
  it("limits downloads per user and frees slots", () => {
    const slots = [];
    for (let i = 0; i < MAX_CONCURRENT_DOWNLOADS; i++) slots.push(takeDownloadSlot("u-test"));
    assert.equal(takeDownloadSlot("u-test"), null);
    assert.ok(takeDownloadSlot("u-other"));
    slots[0]!();
    slots[0]!(); // releasing twice frees only one
    const again = takeDownloadSlot("u-test");
    assert.ok(again);
    assert.equal(takeDownloadSlot("u-test"), null);
  });
});

describe("profiles serialization", () => {
  it("never overlaps tasks and survives a failure", async () => {
    const chain = { tail: Promise.resolve() as Promise<unknown> };
    let running = 0;
    let peak = 0;
    const task = (fail: boolean) => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      if (fail) throw new Error("boom");
      return "ok";
    };
    const results = await Promise.allSettled([serialize(chain, task(true)), serialize(chain, task(false)), serialize(chain, task(false))]);
    assert.equal(peak, 1);
    assert.deepEqual(results.map((r) => r.status), ["rejected", "fulfilled", "fulfilled"]);
  });
});
