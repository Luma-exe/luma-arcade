import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initDb } from "../db/index.js";
import { getSetting, setSetting } from "./settings.js";
import { bundledMoonlightPath, useBundledMoonlight } from "./bundled.js";

describe("bundled moonlight-web-stream", () => {
  beforeEach(() => initDb(":memory:"));

  it("is used and auto-started when the installer shipped it and nothing is set", () => {
    const root = mkdtempSync(path.join(tmpdir(), "luma-bundled-"));
    mkdirSync(path.join(root, "moonlight-web-stream"));
    writeFileSync(bundledMoonlightPath(root), "");
    assert.equal(useBundledMoonlight(root), bundledMoonlightPath(root));
    assert.equal(getSetting("moonlightWebStreamPath"), bundledMoonlightPath(root));
    assert.equal(getSetting("moonlightAutoStart"), true);
  });

  it("leaves a path set by hand alone, and does nothing without the bundle", () => {
    const root = mkdtempSync(path.join(tmpdir(), "luma-bundled-"));
    assert.equal(useBundledMoonlight(root), null);
    assert.equal(getSetting("moonlightWebStreamPath"), "");
    setSetting("moonlightWebStreamPath", "D:\\mine\\web-server.exe");
    mkdirSync(path.join(root, "moonlight-web-stream"));
    writeFileSync(bundledMoonlightPath(root), "");
    assert.equal(useBundledMoonlight(root), null);
    assert.equal(getSetting("moonlightWebStreamPath"), "D:\\mine\\web-server.exe");
  });
});
