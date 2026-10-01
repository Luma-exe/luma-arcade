import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAIN, arrive, arrived, lastPc, savesElsewhere, setLastPc, setSyncDeps, type SyncDeps } from "./saveSync.js";
import type { Seat } from "./seats.js";

const seat2: Seat = { hostId: 200, name: "Seat2", address: "10.0.0.2", httpPort: 47989, owner: null };
const alice = { id: 1, name: "Alice" };

let home: Record<string, string>;
let calls: string[];

function fake(overrides: Partial<SyncDeps> = {}): SyncDeps {
  return {
    readHome: () => ({ ...home }),
    writeHome: (h) => void (home = { ...h }),
    exportMain: async (p) => void calls.push(`export main ${p.id}`),
    exportSeat: async (s, p) => void calls.push(`export ${s.name} ${p.id}`),
    toSeat: async (s, p, _host, seatDir) => void calls.push(`to ${s.name} ${p.id} ${seatDir}`),
    ...overrides,
  };
}

describe("saves follow their player between PCs", () => {
  beforeEach(() => {
    home = {};
    calls = [];
    setSyncDeps(fake());
  });
  afterEach(() => setSyncDeps(null));

  it("everyone starts on the main PC", () => {
    assert.equal(lastPc(1), MAIN);
    assert.equal(savesElsewhere(1, MAIN), false);
    assert.equal(savesElsewhere(1, "Seat2"), true);
  });

  it("nothing moves when they play where they last did", async () => {
    assert.deepEqual(await arrive(alice, MAIN, [seat2]), {});
    assert.deepEqual(calls, []);
  });

  it("first time on a seat: exported from the main PC, copied onto the seat", async () => {
    const answer = await arrive(alice, "Seat2", [seat2]);
    assert.equal(answer.from, MAIN);
    assert.match(answer.import ?? "", /user-1$/);
    assert.deepEqual(calls.map((c) => c.split(" ").slice(0, 3).join(" ")), ["export main 1", "to Seat2 1"]);
    // Only once the seat says it imported them do they live there.
    assert.equal(lastPc(1), MAIN);
    arrived(1, "Seat2", true);
    assert.equal(lastPc(1), "Seat2");
  });

  it("back on the main PC: exported from the seat, imported here", async () => {
    setLastPc(1, "Seat2");
    const answer = await arrive(alice, MAIN, [seat2]);
    assert.equal(answer.from, "Seat2");
    assert.deepEqual(calls, ["export Seat2 1"]);
    arrived(1, MAIN, true);
    assert.equal(lastPc(1), MAIN);
  });

  it("a failed import leaves their saves where they were", async () => {
    await arrive(alice, "Seat2", [seat2]);
    arrived(1, "Seat2", false);
    assert.equal(lastPc(1), MAIN);
  });

  it("an arrival for another PC doesn't count", async () => {
    await arrive(alice, "Seat2", [seat2]);
    arrived(1, MAIN, true);
    assert.equal(lastPc(1), MAIN);
  });

  it("a seat that's gone has nothing to fetch", async () => {
    setLastPc(1, "Seat9");
    assert.deepEqual(await arrive(alice, MAIN, [seat2]), {});
  });

  it("an export that fails is reported, and nothing changes", async () => {
    setSyncDeps(fake({ exportMain: async () => { throw new Error("disk full"); } }));
    await assert.rejects(arrive(alice, "Seat2", [seat2]), /disk full/);
    assert.equal(lastPc(1), MAIN);
  });
});
