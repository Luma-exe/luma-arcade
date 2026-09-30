import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { prepareSaves, savesLoadedFor, swapsSaves, type ReadyDeps } from "./savesReady.js";
import { resetSessions, streamStarted, setSunshineBusy } from "./sessions.js";
import type { StreamUser } from "./streamUser.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const alice: StreamUser = { id: 1, name: "Alice", roleId: 2, admin: false };
const bob: StreamUser = { id: 2, name: "Bob", roleId: 2, admin: false };

/** Sunshine running ES-DE (app 7) with `loaded`'s saves in. */
function deps(loaded: string | null, { busy = true, app = "ES-DE", closes = true } = {}) {
  let running = busy;
  const d: ReadyDeps & { closed: number } = {
    closed: 0,
    running: async () => ({ busy: running, appId: running ? 7 : null }),
    loadedFor: () => loaded,
    appName: async () => app,
    close: async () => {
      d.closed++;
      if (closes) running = false;
      return closes;
    },
    sleep: async () => {},
  };
  return d;
}

beforeEach(() => resetSessions());

describe("getting the player's saves in before they connect", () => {
  it("closes an ES-DE session running with someone else's saves", async () => {
    const d = deps("user-1");
    assert.deepEqual(await prepareSaves(bob, d), { restarted: true });
    assert.equal(d.closed, 1);
  });

  it("leaves it running when the saves in are already theirs", async () => {
    const d = deps("user-2");
    assert.deepEqual(await prepareSaves(bob, d), { restarted: false });
    assert.equal(d.closed, 0);
  });

  it("does nothing when nothing is running (Sunshine starts ES-DE, which swaps them)", async () => {
    const d = deps("user-1", { busy: false });
    assert.deepEqual(await prepareSaves(bob, d), { restarted: false });
    assert.equal(d.closed, 0);
  });

  it("leaves apps that don't swap saves alone (Steam)", async () => {
    const d = deps("user-1", { app: "Steam Big Picture" });
    assert.deepEqual(await prepareSaves(bob, d), { restarted: false });
  });

  it("never closes someone's game for a person who may not connect", async () => {
    streamStarted({ close() {} }, alice);
    setSunshineBusy(true);
    const d = deps("user-1");
    assert.ok("error" in (await prepareSaves(bob, d)));
    assert.equal(d.closed, 0);
  });
});

describe("helpers", () => {
  it("reads whose saves are in from profiles' state file (with a BOM)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "luma-state-"));
    const file = path.join(dir, "state.json");
    writeFileSync(file, "﻿" + JSON.stringify({ current: "user-5", slots: {} }));
    assert.equal(savesLoadedFor(file), "user-5");
    assert.equal(savesLoadedFor(path.join(dir, "missing.json")), null);
  });

  it("knows which apps swap saves", () => {
    assert.equal(swapsSaves("ES-DE"), true);
    assert.equal(swapsSaves("Steam Big Picture"), false);
    assert.equal(swapsSaves(null), false);
  });
});
