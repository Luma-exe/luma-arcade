import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { screenSizeCheck } from "./routes/health.js";

describe("game screen size check", () => {
  it("is fine with no stream, or when the screen matches it", () => {
    assert.equal(screenSizeCheck(null, "3840x2160", null).status, "ok");
    assert.equal(screenSizeCheck("1920x1080", "1920x1080", null).status, "ok");
  });

  it("names the game that switched the screen to another size", () => {
    const c = screenSizeCheck("1920x1080", "3840x2160", "FIFA23");
    assert.equal(c.status, "warn");
    assert.match(c.detail, /^FIFA23 switched the PC's screen to 3840x2160 under a 1920x1080 stream/);
  });
});
