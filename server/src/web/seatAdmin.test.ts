import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createSeat,
  nextSeatName,
  removeSeat,
  setSeatAdminDeps,
  syncPairing,
  validateNewSeat,
  type ManagedSeat,
  type ManagerStatus,
  type SeatAdminDeps,
  type SeatHostInfo,
} from "./seatAdmin.js";
import { lastPc, setLastPc, setSyncDeps } from "./saveSync.js";
import { removeSeatHosts, seatPairing, upsertSeatHost, type MoonlightData } from "../remote/moonlightData.js";
import { initDb } from "../db/index.js";

const host: SeatHostInfo = {
  checked: new Date().toISOString(),
  edition: "Windows Server 2025",
  server: true,
  hyperV: "on",
  gpuPolicy: "allowed",
  gpus: [{ path: "\\\\?\\PCI#VEN_10DE&DEV_1B80#1", name: "GTX 1080", vendor: "NVIDIA" }],
  switch: "ExternalSwitch",
  share: "\\\\PC\\LumaArcadeGames",
  gamesRoot: "G:",
  hostAddress: "10.0.0.1",
  memoryGb: 32,
  freeMemoryGb: 12,
  cpus: 20,
  storage: "C:\\Hyper-V",
  storageFreeGb: 400,
  isos: [],
  setupScripts: true,
  problems: [],
  ready: true,
};

function seat(over: Partial<ManagedSeat> = {}): ManagedSeat {
  return {
    name: "Seat2", managed: true, vm: "Running", uptimeMin: 5, address: "10.0.0.2", memoryGb: 6, cpus: 6, gpuShare: 0.5,
    stage: "ready", stageLabel: "", detail: "", step: 0, steps: 8, error: null, finished: true, working: null,
    created: null, serverCert: "CERT", httpPort: 47989, ...over,
  };
}

let requests: { action: string; body: Record<string, unknown> }[];
let paired: Map<string, string>;
let pairs: string[];
let unpaired: string[];
let streaming: boolean;
let status: ManagerStatus;

function useDeps(over: Partial<SeatAdminDeps> = {}) {
  setSeatAdminDeps({
    readStatus: () => status,
    request: (action, body) => {
      requests.push({ action, body });
      return String(requests.length);
    },
    readResponse: () => null,
    startManager: async () => {},
    anyoneStreaming: () => streaming,
    clientCert: () => "CLIENT",
    pair: async (s) => {
      pairs.push(`${s.name}@${s.address}`);
      paired.set(s.name, s.address);
    },
    unpair: async (name) => {
      unpaired.push(name);
      return paired.delete(name) ? 1 : 0;
    },
    paired: () => paired,
    ...over,
  });
}

describe("extra seats admin", () => {
  let home: Record<string, string>;
  // Settings (Luma Arcade's port) live in the database.
  initDb(":memory:");
  beforeEach(() => {
    requests = [];
    paired = new Map();
    pairs = [];
    unpaired = [];
    streaming = false;
    home = {};
    status = { updated: new Date().toISOString(), pid: 1, host, seats: [], jobs: [] };
    setSyncDeps({
      readHome: () => ({ ...home }),
      writeHome: (h) => void (home = { ...h }),
      exportMain: async () => {},
      exportSeat: async () => {},
      toSeat: async () => {},
      importMain: async () => {},
      importSeat: async () => {},
    });
    useDeps();
  });
  afterEach(() => {
    setSeatAdminDeps(null);
    setSyncDeps(null);
  });

  it("names seats after the main PC: Seat2, Seat3, filling gaps", () => {
    assert.equal(nextSeatName([]), "Seat2");
    assert.equal(nextSeatName(["Seat2", "Seat 3"]), "Seat4");
    assert.equal(nextSeatName(["Seat3"]), "Seat2");
  });

  it("checks a new seat's settings", () => {
    const ok = validateNewSeat({ iso: "E:\\ISOs\\Win11.iso", memoryGb: 6, cpus: 6, diskGb: 120, gpuShare: 0.5 }, host);
    assert.deepEqual(ok, { iso: "E:\\ISOs\\Win11.iso", memoryGb: 6, cpus: 6, diskGb: 120, gpuShare: 0.5 });
    assert.throws(() => validateNewSeat({ iso: "win11.iso", memoryGb: 6, cpus: 6, diskGb: 120, gpuShare: 0.5 }, host), /full path/);
    assert.throws(() => validateNewSeat({ iso: "E:\\a.iso", memoryGb: 2, cpus: 6, diskGb: 120, gpuShare: 0.5 }, host), /Memory/);
    // Leaves the main PC at least two processors.
    assert.throws(() => validateNewSeat({ iso: "E:\\a.iso", memoryGb: 6, cpus: 19, diskGb: 120, gpuShare: 0.5 }, host), /Processors/);
    assert.throws(() => validateNewSeat({ iso: "E:\\a.iso", memoryGb: 6, cpus: 6, diskGb: 120, gpuShare: 1 }, host), /share/);
    assert.throws(() => validateNewSeat({ iso: "E:\\a.iso", memoryGb: 6, cpus: 6, diskGb: 120, gpuShare: 0.5, gpu: "other" }, host), /partitioned/);
  });

  it("asks the manager to build the next seat, with what pairing needs", async () => {
    paired.set("Seat2", "10.0.0.2");
    const name = await createSeat({ iso: "E:\\w.iso", memoryGb: 6, cpus: 4, diskGb: 100, gpuShare: 0.3 });
    assert.equal(name, "Seat3");
    assert.equal(requests[0].action, "create");
    assert.equal(requests[0].body.name, "Seat3");
    assert.equal(requests[0].body.clientCert, "CLIENT");
  });

  it("won't build on a PC that isn't ready", async () => {
    status.host = { ...host, ready: false, problems: ["Hyper-V is off."] };
    await assert.rejects(createSeat({ iso: "E:\\w.iso", memoryGb: 6, cpus: 4, diskGb: 100, gpuShare: 0.3 }), /Hyper-V is off/);
    assert.equal(requests.length, 0);
  });

  it("pairs a finished seat, but not while someone's playing", async () => {
    status.seats = [seat(), seat({ name: "Seat3", finished: false, stage: "windows" })];
    streaming = true;
    assert.deepEqual(await syncPairing(), []);
    assert.deepEqual(pairs, []);
    // An admin can pair it now anyway.
    assert.deepEqual(await syncPairing({ now: true }), ["Seat2"]);
    assert.deepEqual(pairs, ["Seat2@10.0.0.2"]);
    // Nothing more to do.
    streaming = false;
    assert.deepEqual(await syncPairing(), []);
  });

  it("follows a seat whose address changed", async () => {
    paired.set("Seat2", "10.0.0.2");
    status.seats = [seat({ address: "10.0.0.9" })];
    assert.deepEqual(await syncPairing(), ["Seat2"]);
    assert.equal(paired.get("Seat2"), "10.0.0.9");
  });

  it("doesn't pair a seat that's off", async () => {
    status.seats = [seat({ vm: "Off" })];
    assert.deepEqual(await syncPairing({ now: true }), []);
  });

  it("brings players' saves home before removing a seat", async () => {
    paired.set("Seat2", "10.0.0.2");
    status.seats = [seat()];
    setLastPc(1, "Seat2");
    const result = await removeSeat("Seat2", { players: [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }] });
    assert.deepEqual(result, { moved: ["Alice"], lost: [] });
    assert.equal(lastPc(1), "main");
    assert.deepEqual(unpaired, ["Seat2"]);
    assert.deepEqual(requests.map((r) => r.action), ["remove"]);
  });

  it("keeps a seat whose saves can't be brought home, unless forced", async () => {
    status.seats = [seat()];
    setLastPc(1, "Seat2");
    setSyncDeps({
      readHome: () => ({ ...home }),
      writeHome: (h) => void (home = { ...h }),
      exportMain: async () => {},
      exportSeat: async () => {
        throw new Error("the seat is off");
      },
      toSeat: async () => {},
      importMain: async () => {},
      importSeat: async () => {},
    });
    paired.set("Seat2", "10.0.0.2");
    // saveSync only knows seats moonlight has paired.
    const { setSeatDeps } = await import("./seats.js");
    setSeatDeps({ seats: () => [{ hostId: 7, name: "Seat2", address: "10.0.0.2", httpPort: 47989, owner: null }], online: async () => true, close: async () => {} });
    try {
      await assert.rejects(removeSeat("Seat2", { players: [{ id: 1, name: "Alice" }] }), /Alice's saves/);
      assert.deepEqual(requests, []);
      const result = await removeSeat("Seat2", { force: true, players: [{ id: 1, name: "Alice" }] });
      assert.deepEqual(result.lost, ["Alice"]);
      assert.equal(lastPc(1), "main");
      assert.deepEqual(requests.map((r) => r.action), ["remove"]);
    } finally {
      setSeatDeps(null);
    }
  });

  it("only unpairs a seat it didn't build", async () => {
    paired.set("Seat2", "10.0.0.2");
    status.seats = [seat({ managed: false })];
    await removeSeat("Seat2", { players: [] });
    assert.deepEqual(unpaired, ["Seat2"]);
    assert.deepEqual(requests, []);
  });

  it("refuses names that aren't seats", async () => {
    await assert.rejects(removeSeat("MainServer", { players: [] }), /No such seat/);
  });
});

describe("pairing a seat in moonlight-web-stream's data", () => {
  function data(): MoonlightData {
    return {
      users: { "1": { name: "admin", role_id: 1 } },
      roles: {},
      hosts: {
        "100": {
          owner: null,
          address: "localhost",
          http_port: 47989,
          pair_info: { client_private_key: "KEY", client_certificate: "CLIENT", server_certificate: "MAIN" },
          cache: { name: "MainServer", mac: null },
        },
      },
    };
  }

  it("adds a seat with the main PC's client pairing and the seat's certificate", () => {
    const d = data();
    upsertSeatHost(d, { name: "Seat2", address: "10.0.0.2", httpPort: 47989, serverCert: "SEAT" });
    const added = Object.values(d.hosts).find((h) => h.cache?.name === "Seat2")!;
    assert.equal(added.owner, null);
    assert.deepEqual(added.pair_info, { client_private_key: "KEY", client_certificate: "CLIENT", server_certificate: "SEAT" });
    assert.deepEqual([...seatPairing(d)], [["Seat2", "10.0.0.2"]]);
  });

  it("updates every copy of a seat in place, and removes them all", () => {
    const d = data();
    upsertSeatHost(d, { name: "Seat2", address: "10.0.0.2", httpPort: 47989, serverCert: "SEAT" });
    const id = Object.keys(d.hosts).find((k) => d.hosts[k].cache?.name === "Seat2")!;
    d.hosts["555"] = { ...structuredClone(d.hosts[id]), owner: 1 };
    upsertSeatHost(d, { name: "Seat2", address: "10.0.0.7", httpPort: 47989, serverCert: "SEAT2" });
    assert.equal(Object.keys(d.hosts).length, 3);
    assert.ok(Object.values(d.hosts).filter((h) => h.cache?.name === "Seat2").every((h) => h.address === "10.0.0.7"));
    assert.equal(removeSeatHosts(d, "Seat2"), 2);
    assert.deepEqual(Object.keys(d.hosts), ["100"]);
  });

  it("can't pair a seat before the main PC is paired", () => {
    const d = data();
    d.hosts["100"].pair_info = undefined;
    assert.throws(() => upsertSeatHost(d, { name: "Seat2", address: "10.0.0.2", httpPort: 47989, serverCert: "SEAT" }), /isn't paired/);
  });
});
