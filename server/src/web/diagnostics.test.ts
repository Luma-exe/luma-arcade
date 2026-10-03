import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { clearProblems, formatReport, looksLikeError, problemLogHook, recentProblems, recordProblem, redact } from "./diagnostics.js";

describe("diagnostics", () => {
  beforeEach(() => clearProblems());

  it("takes out addresses, names, emails and tokens", () => {
    const text = redact(
      "TURN at 203.0.113.7, PC GAMING-RIG signed in as Dylan, mail sam@example.com, token abcdefghijklmnopqrstuvwxyzABCDEF123, local 127.0.0.1",
      ["GAMING-RIG", "Dylan"]
    );
    assert.equal(text, "TURN at <ip>, PC <name> signed in as <name>, mail <email>, token <token>, local 127.0.0.1");
  });

  it("only takes out whole names", () => {
    assert.equal(redact("Ben ran the Benchmark; Sam (guest) joined", ["Ben", "Sam (guest)"]), "<name> ran the Benchmark; <name> joined");
  });

  it("keeps the last 40 problems", () => {
    for (let i = 0; i < 50; i++) recordProblem("test", `problem ${i}`);
    const kept = recentProblems();
    assert.equal(kept.length, 40);
    assert.equal(kept[0].text, "problem 10");
  });

  it("keeps warnings and errors from the log, not info", () => {
    const seen: unknown[][] = [];
    const method = (...a: unknown[]) => seen.push(a);
    problemLogHook([{ err: { message: "boom" } }, "request failed"], method, 50);
    problemLogHook(["all fine"], method, 30);
    assert.deepEqual(recentProblems().map((p) => p.text), ["boom - request failed"]);
    // Everything still reaches the log.
    assert.equal(seen.length, 2);
  });

  it("spots error lines from programs", () => {
    assert.equal(looksLikeError("[ERROR] stream failed: timeout"), true);
    assert.equal(looksLikeError("client connected"), false);
  });

  it("lays the report out for a GitHub issue", () => {
    const now = Date.now();
    const text = formatReport(
      {
        version: "1.2.0",
        commit: "e3b0637abcdef",
        node: "24.1.0",
        uptimeMin: 12,
        pc: { windows: "Windows 11 Pro 24H2 (build 26100)", cpu: "Ryzen 5 5600X", ramGb: 32, graphics: ["NVIDIA GeForce RTX 3070 (driver 32.0)"], sunshine: "2025.924" },
        checks: [
          { id: "a", label: "Sunshine", status: "ok", detail: "running" },
          { id: "b", label: "Virtual display", status: "error", detail: "not installed" },
        ],
        problems: [{ at: now - 3 * 60_000, source: "moonlight", text: "ERROR something broke" }],
      },
      now
    );
    assert.match(text, /Luma Arcade\*\* 1\.2\.0 \(e3b0637\)/);
    assert.match(text, /✅ Sunshine: running/);
    assert.match(text, /❌ Virtual display: not installed/);
    assert.match(text, /3 min ago \[moonlight\] ERROR something broke/);
  });
});
