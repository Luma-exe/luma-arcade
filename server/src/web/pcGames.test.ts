import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pcGamesCheck, readPcGamesStatus } from "./pcGames.js";

describe("PC games in Host health", () => {
  const now = Date.parse("2026-10-03T12:00:00Z");

  it("asks for Setup when the task isn't there", () => {
    const c = pcGamesCheck(null, false, now);
    assert.equal(c.status, "warn");
    assert.equal(c.action, undefined);
  });

  it("offers Import now before the first import", () => {
    const c = pcGamesCheck(null, true, now);
    assert.equal(c.status, "warn");
    assert.equal(c.action?.id, "import-pc-games");
  });

  it("says what's in ES-DE and what changed", () => {
    const c = pcGamesCheck({ at: "2026-10-03T11:30:00Z", steam: 4, epic: 2, added: ["Portal 2"], removed: [] }, true, now);
    assert.equal(c.status, "ok");
    assert.equal(c.detail, "4 Steam and 2 Epic games in ES-DE, checked (30 min ago): added Portal 2");
  });

  it("counts the other launchers' games too", () => {
    const c = pcGamesCheck({ at: "2026-10-03T11:30:00Z", steam: 4, epic: 2, other: 3, launchers: { "Xbox app": 2, GOG: 1 } }, true, now);
    assert.equal(c.detail, "4 Steam, 2 Epic and 2 Xbox app, 1 GOG games in ES-DE, checked (30 min ago)");
  });

  it("shows a failed import", () => {
    const c = pcGamesCheck({ at: "2026-10-03T11:59:30Z", error: "host.json has no ES-DE folder" }, true, now);
    assert.equal(c.status, "warn");
    assert.match(c.detail, /failed \(just now\): host\.json has no ES-DE folder/);
  });

  it("reads PowerShell's UTF-8 with a byte order mark", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "luma-pcg-")), "pc-games.json");
    writeFileSync(file, "\uFEFF" + JSON.stringify({ steam: 3, epic: 1 }));
    assert.deepEqual(readPcGamesStatus(file), { steam: 3, epic: 1 });
  });
});
