import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stampLines } from "./stderrTimestamps.js";

describe("stderr timestamps", () => {
  it("stamps each line that starts in the chunk", () => {
    assert.equal(stampLines("a\nb\n", true, "T"), "T a\nT b\n");
  });
  it("doesn't stamp the rest of a line continued from the last chunk", () => {
    assert.equal(stampLines("rest\nnext", false, "T"), "rest\nT next");
  });
});
