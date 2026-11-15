import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initDb } from "../db/index.js";
import { setSetting } from "../config/settings.js";
import { checkForUpdate, compareVersions, resetUpdateCache } from "./updateCheck.js";

const realFetch = globalThis.fetch;
let calls = 0;
function github(status: number, body: object = {}): void {
  globalThis.fetch = (async () => {
    calls++;
    return Response.json(body, { status });
  }) as typeof fetch;
}
const localVersion = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
const bump = (v: string) => v.replace(/^(\d+)/, (m) => String(Number(m) + 1));

beforeEach(() => {
  initDb(":memory:");
  setSetting("devTreePath", "");
  resetUpdateCache();
  calls = 0;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("version compare", () => {
  it("orders versions as semver, not as text", () => {
    assert.ok(compareVersions("1.10.0", "1.9.0")! > 0);
    assert.ok(compareVersions("v1.3.1", "1.3.2")! < 0);
    assert.equal(compareVersions("v1.3.1", "1.3.1"), 0);
    assert.ok(compareVersions("1.4.0-beta.1", "1.4.0")! < 0);
    assert.ok(compareVersions("1.4.0-beta.2", "1.4.0-beta.10")! < 0);
    assert.equal(compareVersions("nightly", "1.0.0"), null);
  });
});

describe("update check", () => {
  it("offers a newer release with its page", async () => {
    const tag = `v${bump(localVersion)}`;
    github(200, { tag_name: tag, html_url: "https://github.com/x/releases/tag/t", draft: false, prerelease: false });
    const s = await checkForUpdate();
    assert.equal(s.localVersion, localVersion);
    assert.equal(s.latestVersion, tag.slice(1));
    assert.equal(s.updateAvailable, true);
    assert.equal(s.downloadUrl, "https://github.com/x/releases/tag/t");
    assert.equal(s.canApply, false);
    assert.equal(s.error, undefined);
  });

  it("is up to date on the same version", async () => {
    github(200, { tag_name: `v${localVersion}`, html_url: "u" });
    const s = await checkForUpdate();
    assert.equal(s.updateAvailable, false);
    assert.equal(s.latestVersion, localVersion);
  });

  it("ignores prereleases", async () => {
    github(200, { tag_name: `v${bump(localVersion)}`, html_url: "u", prerelease: true });
    const s = await checkForUpdate();
    assert.equal(s.updateAvailable, false);
    assert.equal(s.latestVersion, null);
  });

  it("no releases yet is no update and no error", async () => {
    github(404, { message: "Not Found" });
    const s = await checkForUpdate();
    assert.equal(s.updateAvailable, false);
    assert.equal(s.latestVersion, null);
    assert.equal(s.downloadUrl, null);
    assert.equal(s.error, undefined);
  });

  it("reports other failures as an error", async () => {
    github(500);
    const s = await checkForUpdate();
    assert.match(s.error ?? "", /500/);
    assert.equal(s.updateAvailable, false);
  });

  it("asks GitHub once an hour", async () => {
    github(404);
    const t = 1_000_000;
    await checkForUpdate(t);
    await checkForUpdate(t + 59 * 60_000);
    assert.equal(calls, 1);
    await checkForUpdate(t + 61 * 60_000);
    assert.equal(calls, 2);
  });

  it("remembers a failure for five minutes instead of asking again", async () => {
    github(500);
    const t = 1_000_000;
    const first = await checkForUpdate(t);
    const second = await checkForUpdate(t + 4 * 60_000);
    assert.equal(calls, 1);
    assert.equal(second.error, first.error);
    await checkForUpdate(t + 6 * 60_000);
    assert.equal(calls, 2);
  });

  it("gives up on a hung request (fetch gets a timeout signal)", async () => {
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      signal = init?.signal;
      throw new Error("offline");
    }) as typeof fetch;
    const s = await checkForUpdate(1_000_000);
    assert.ok(signal instanceof AbortSignal);
    assert.match(s.error ?? "", /offline/);
  });
});
