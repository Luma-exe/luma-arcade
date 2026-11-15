import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cachedHostChecks, invalidateHostChecks, tailFile, type HealthCheck } from "./routes/health.js";
import { appListSource, resetAppNames, sunshineAppId, sunshineAppName } from "./sunshine.js";
import { clearCoverMemo, coverFile } from "./games.js";

const check = (n: number): HealthCheck[] => [{ id: "x", label: "X", status: "ok", detail: String(n) }];

describe("cachedHostChecks", () => {
  beforeEach(() => invalidateHostChecks());

  it("computes once for repeated and overlapping calls, until the result is too old", async () => {
    let runs = 0;
    let clock = 1000;
    const compute = async () => check(++runs);
    const now = () => clock;
    const [a, b] = await Promise.all([cachedHostChecks(3000, compute, now), cachedHostChecks(3000, compute, now)]);
    assert.equal(runs, 1);
    assert.deepEqual(a, b);
    clock += 2000;
    await cachedHostChecks(3000, compute, now);
    assert.equal(runs, 1);
    // a longer max age for players, a shorter one for admins
    clock += 2000;
    await cachedHostChecks(30_000, compute, now);
    assert.equal(runs, 1);
    await cachedHostChecks(3000, compute, now);
    assert.equal(runs, 2);
  });

  it("recomputes after invalidation, and drops a run that started before it", async () => {
    let runs = 0;
    const now = () => 5000;
    await cachedHostChecks(30_000, async () => check(++runs), now);
    invalidateHostChecks();
    await cachedHostChecks(30_000, async () => check(++runs), now);
    assert.equal(runs, 2);

    invalidateHostChecks();
    let release: () => void = () => {};
    const slow = cachedHostChecks(30_000, () => new Promise<HealthCheck[]>((r) => (release = () => r(check(99)))), now);
    invalidateHostChecks();
    release();
    await slow;
    await cachedHostChecks(30_000, async () => check(++runs), now);
    assert.equal(runs, 3);
  });
});

describe("tailFile", () => {
  it("returns the whole small file and only the end of a big one", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "luma-tail-")), "a.log");
    writeFileSync(file, "hello\nworld\n");
    assert.equal(tailFile(file), "hello\nworld\n");
    writeFileSync(file, "x".repeat(1000) + "END");
    assert.equal(tailFile(file, 10), "xxxxxxxEND");
  });
});

describe("Sunshine app lookup", () => {
  const xml = "<root><App><AppTitle>ES-DE</AppTitle><ID>7</ID></App></root>";
  let fetches = 0;
  let clock = 0;
  const real = { ...appListSource };
  beforeEach(() => {
    resetAppNames();
    fetches = 0;
    clock = 1_000_000;
    appListSource.now = () => clock;
    appListSource.get = async () => {
      fetches++;
      return { status: "ok", code: 200, body: xml };
    };
  });
  it("asks again for a missing app at most once per 30 seconds", async () => {
    assert.equal(await sunshineAppId("ES-DE"), 7);
    assert.equal(fetches, 1);
    assert.equal(await sunshineAppId("Nope"), null);
    assert.equal(fetches, 1); // list was fetched just now
    clock += 10_000;
    assert.equal(await sunshineAppId("Nope"), null);
    assert.equal(await sunshineAppName(99), null);
    assert.equal(fetches, 1);
    clock += 31_000;
    assert.equal(await sunshineAppId("Nope"), null);
    assert.equal(fetches, 2);
    assert.equal(await sunshineAppId("Nope"), null);
    assert.equal(fetches, 2);
  });
  it("doesn't hammer Sunshine while it is down", async () => {
    appListSource.get = async () => {
      fetches++;
      return { status: "hung" };
    };
    assert.equal(await sunshineAppId("ES-DE"), null);
    assert.equal(await sunshineAppId("ES-DE"), null);
    assert.equal(fetches, 1);
    clock += 31_000;
    await sunshineAppId("ES-DE");
    assert.equal(fetches, 2);
  });
  it("restores", () => {
    Object.assign(appListSource, real);
  });
});

describe("cover lookups", () => {
  it("remember a miss for a minute", () => {
    clearCoverMemo();
    const media = mkdtempSync(path.join(os.tmpdir(), "luma-media-"));
    const play = { rom: "/home/x/ES-DE/ROMs/snes/Game.sfc", system: "snes" };
    assert.equal(coverFile(play, media, 0), null);
    const dir = path.join(media, "snes", "covers");
    require_mkdir(dir);
    writeFileSync(path.join(dir, "Game.png"), "p");
    assert.equal(coverFile(play, media, 30_000), null);
    assert.equal(coverFile(play, media, 61_000), path.join(dir, "Game.png"));
  });
});

import { mkdirSync } from "node:fs";
function require_mkdir(dir: string) {
  mkdirSync(dir, { recursive: true });
}
