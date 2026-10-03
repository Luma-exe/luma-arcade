import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { earlyTestingCheck, uinputCheck } from "./linuxHost.js";

describe("Linux host health", () => {
  it("says Linux support is an early beta", () => {
    const c = earlyTestingCheck();
    assert.equal(c.status, "warn");
    assert.match(c.detail, /early beta/i);
  });

  it("explains a missing uinput device", () => {
    const c = uinputCheck(path.join(tmpdir(), "no-such-uinput"));
    assert.equal(c.status, "error");
    assert.match(c.detail, /modprobe uinput/);
  });

  it("is happy with a writable one", () => {
    const device = path.join(mkdtempSync(path.join(tmpdir(), "luma-uinput-")), "uinput");
    writeFileSync(device, "");
    assert.equal(uinputCheck(device).status, "ok");
  });
});
