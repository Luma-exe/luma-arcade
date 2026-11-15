import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, renameSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROTATE_RETRY_MS, RotatingLog, rotateFiles, rotateIfTooBig, type RotateOps } from "./logFile.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "luma-log-"));
  file = path.join(dir, "logs", "server.log");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("log rotation", () => {
  it("shifts the old files along and drops the oldest", () => {
    writeFileSync(file = path.join(dir, "s.log"), "now");
    writeFileSync(`${file}.1`, "one");
    writeFileSync(`${file}.2`, "two");
    writeFileSync(`${file}.3`, "three");
    rotateFiles(file, 3);
    assert.equal(existsSync(file), false);
    assert.equal(readFileSync(`${file}.1`, "utf8"), "now");
    assert.equal(readFileSync(`${file}.2`, "utf8"), "one");
    assert.equal(readFileSync(`${file}.3`, "utf8"), "two");
    assert.equal(existsSync(`${file}.4`), false);
  });

  it("rotateIfTooBig leaves a small or missing file alone", () => {
    assert.equal(rotateIfTooBig(path.join(dir, "none.log"), 10), false);
    writeFileSync(file = path.join(dir, "s.log"), "12345");
    assert.equal(rotateIfTooBig(file, 10), false);
    writeFileSync(file, "12345678901");
    assert.equal(rotateIfTooBig(file, 10), true);
    assert.equal(existsSync(`${file}.1`), true);
  });

  it("creates the folder, appends, and rotates once past the cap", () => {
    const log = new RotatingLog(file, 25, 3);
    log.write("0123456789\n");
    log.write("0123456789\n");
    assert.equal(existsSync(`${file}.1`), false);
    log.write("0123456789\n"); // 33 bytes: over 25
    assert.equal(readFileSync(`${file}.1`, "utf8"), "0123456789\n".repeat(3));
    log.write("after\n");
    assert.equal(readFileSync(file, "utf8"), "after\n");
    log.close();
  });

  it("rotates a file that was already too big when the server started", () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "123456789");
    const log = new RotatingLog(file, 5, 3);
    assert.equal(existsSync(file), false);
    assert.equal(readFileSync(`${file}.1`, "utf8"), "123456789");
    log.close();
  });

  it("keeps only server.log.1 to .3", () => {
    const log = new RotatingLog(file, 3, 3);
    for (let i = 0; i < 6; i++) log.write(`line${i}\n`);
    log.close();
    assert.equal(existsSync(`${file}.3`), true);
    assert.equal(existsSync(`${file}.4`), false);
  });

  it("leaves the older files alone when the live file can't be renamed, and backs off", () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.1`, "one");
    writeFileSync(`${file}.2`, "two");
    let t = 1000;
    let renames = 0;
    let failing = true;
    const ops: RotateOps = {
      renameSync(from, to) {
        renames++;
        if (failing && from === file) throw new Error("EBUSY");
        renameSync(from, to);
      },
      rmSync,
      existsSync,
      now: () => t,
    };
    const log = new RotatingLog(file, 5, 3, ops);
    log.write("123456789\n"); // over the cap: tries, fails
    assert.equal(renames, 1);
    assert.equal(readFileSync(`${file}.1`, "utf8"), "one");
    assert.equal(readFileSync(`${file}.2`, "utf8"), "two");
    assert.equal(existsSync(`${file}.3`), false);
    log.write("more\n"); // still appends, and doesn't retry yet
    assert.equal(renames, 1);
    assert.equal(readFileSync(file, "utf8"), "123456789\nmore\n");
    t += ROTATE_RETRY_MS + 1;
    failing = false;
    log.write("again\n"); // backoff over: rotates
    assert.equal(readFileSync(`${file}.1`, "utf8"), "123456789\nmore\nagain\n");
    assert.equal(readFileSync(`${file}.2`, "utf8"), "one");
    assert.equal(readFileSync(`${file}.3`, "utf8"), "two");
    log.close();
  });
});
