import type { FastifyBaseLogger } from "fastify";
import { getSetting } from "../config/settings.js";
import { editData, readData, removeSeatHosts, seatPairing, upsertSeatHost } from "../remote/moonlightData.js";
import { IS_WINDOWS } from "../platform.js";
import { SEATS_DIR, managerInstalled, readResponse, readStatusFile, startManagerTask, STALE_MS, writeRequest } from "./seatManager.js";
import { lastPc, MAIN, fetchTo, setLastPc, type Player } from "./saveSync.js";
import { listSeats, resetSeats, SEAT_NAME, seatsStatus } from "./seats.js";
import { nobodyStreamingFor } from "./sessions.js";

// Settings > Extra seats: adding, removing, starting and stopping seats
// (seats.ts streams them). The work is done on the PC by
// host/seat-manager.ps1, as SYSTEM (Hyper-V needs an administrator; Luma
// Arcade runs as the games account): requests go into seats\requests, it
// answers in seats\responses and keeps seats\status.json current. When a
// seat is built, Luma Arcade pairs it with moonlight-web-stream (data.json),
// which restarts the streaming server - so it waits until nobody's playing.

export { SEATS_DIR };

export interface SeatGpu {
  path: string;
  name: string;
  vendor: string;
}

export interface SeatHostInfo {
  checked: string;
  edition: string;
  server: boolean;
  hyperV: "on" | "off" | "restart" | "unavailable";
  gpuPolicy: "allowed" | "blocked" | "not-needed";
  gpus: SeatGpu[];
  switch: string | null;
  share: string | null;
  gamesRoot: string | null;
  hostAddress: string | null;
  memoryGb: number;
  freeMemoryGb: number;
  cpus: number;
  storage: string;
  storageFreeGb: number;
  isos: string[];
  setupScripts: boolean;
  problems: string[];
  ready: boolean;
}

export interface ManagedSeat {
  name: string;
  managed: boolean;
  vm: string | null;
  uptimeMin: number;
  address: string | null;
  memoryGb: number;
  cpus: number;
  gpuShare: number | null;
  stage: string;
  stageLabel: string;
  detail: string;
  step: number;
  steps: number;
  error: string | null;
  finished: boolean;
  working: string | null;
  created: string | null;
  serverCert: string | null;
  httpPort: number;
}

export interface ManagerStatus {
  updated: string;
  pid: number;
  host: SeatHostInfo;
  seats: ManagedSeat[];
  jobs: { kind: string; name: string; started: string }[];
}

export interface SeatAdminDeps {
  readStatus(): ManagerStatus | null;
  /** Drops a request for the manager; returns its id. */
  request(action: string, body: Record<string, unknown>): string;
  readResponse(id: string): { ok: boolean; error?: string; [k: string]: unknown } | null;
  startManager(): Promise<void>;
  /** Anyone streaming anywhere (pairing restarts the streaming server). */
  anyoneStreaming(): boolean;
  /** moonlight's client certificate (public): the seat trusts it. */
  clientCert(): string | null;
  pair(seat: { name: string; address: string; httpPort: number; serverCert: string }): Promise<void>;
  unpair(name: string): Promise<number>;
  /** Paired seats: name -> address, as moonlight-web-stream has them. */
  paired(): Map<string, string>;
}

const realDeps: SeatAdminDeps = {
  readStatus: () => readStatusFile<ManagerStatus>(),
  request: writeRequest,
  readResponse,
  startManager: startManagerTask,
  anyoneStreaming: () => nobodyStreamingFor() === 0 || seatsStatus().some((s) => s.streaming),
  clientCert: () => {
    for (const host of Object.values(readData().hosts ?? {})) {
      const pair = host.pair_info as { client_certificate?: string } | undefined;
      if (pair?.client_certificate && /^(localhost|127\.0\.0\.1|::1)$/.test(host.address)) return pair.client_certificate;
    }
    return null;
  },
  pair: async (seat) => {
    await editData((data) => upsertSeatHost(data, seat));
    resetSeats();
  },
  unpair: async (name) => {
    if (!seatPairing(readData()).has(name)) return 0;
    const n = await editData((data) => removeSeatHosts(data, name));
    resetSeats();
    return n;
  },
  paired: () => seatPairing(readData()),
};

let deps: SeatAdminDeps = realDeps;
let lastStart = 0;

/** Tests. */
export function setSeatAdminDeps(next: SeatAdminDeps | null): void {
  deps = next ?? realDeps;
  lastStart = 0;
  pairingNote.clear();
}

/** Why a finished seat isn't paired yet (shown on the settings page). */
const pairingNote = new Map<string, string>();

async function ensureManager(now = Date.now()): Promise<boolean> {
  const status = deps.readStatus();
  const fresh = !!status && now - Date.parse(status.updated) < STALE_MS;
  if (!fresh && now - lastStart > 30_000) {
    lastStart = now;
    await deps.startManager().catch(() => {});
  }
  return fresh;
}

/** Everything the settings page shows: this PC, its seats, who's on them. */
export async function seatsOverview(now = Date.now()) {
  if (!IS_WINDOWS) return { supported: false, running: false, status: null, seats: [] };
  const running = await ensureManager(now);
  const status = deps.readStatus();
  const paired = deps.paired();
  const live = new Map(seatsStatus(now).map((s) => [s.name, s]));
  const names = new Set([...(status?.seats ?? []).map((s) => s.name), ...paired.keys()]);
  const seats = [...names].sort(bySeatNumber).map((name) => {
    const m = status?.seats.find((s) => s.name === name) ?? null;
    const holder = live.get(name);
    return {
      name,
      managed: m?.managed ?? false,
      vm: m?.vm ?? null,
      address: m?.address ?? paired.get(name) ?? null,
      memoryGb: m?.memoryGb ?? null,
      cpus: m?.cpus ?? null,
      gpuShare: m?.gpuShare ?? null,
      uptimeMin: m?.uptimeMin ?? 0,
      stage: m?.stage ?? "ready",
      stageLabel: m?.stageLabel ?? "",
      detail: m?.detail ?? "",
      step: m?.step ?? 0,
      steps: m?.steps ?? 0,
      error: m?.error ?? null,
      finished: m ? m.finished : true,
      working: m?.working ?? null,
      created: m?.created ?? null,
      paired: paired.has(name),
      pairingNote: pairingNote.get(name) ?? null,
      player: holder?.user ?? null,
      streaming: holder?.streaming ?? false,
    };
  });
  // Only what the page needs from the PC's checks.
  return { supported: true, running, updated: status?.updated ?? null, host: status?.host ?? null, jobs: status?.jobs ?? [], seats };
}

function bySeatNumber(a: string, b: string): number {
  return Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")) || a.localeCompare(b);
}

/** The next free name: Seat2, Seat3... (the main PC is seat 1). */
export function nextSeatName(taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.toLowerCase().replace(/\s+/g, "")));
  for (let n = 2; n < 100; n++) if (!used.has(`seat${n}`)) return `Seat${n}`;
  throw new Error("That's a lot of seats");
}

export interface NewSeat {
  iso: string;
  memoryGb: number;
  cpus: number;
  diskGb: number;
  /** Share of the graphics card, 0.1 - 0.9. */
  gpuShare: number;
  gpu?: string;
}

function num(value: unknown, min: number, max: number, what: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${what} must be between ${min} and ${max}`);
  return n;
}

/** Checks what the page sent for a new seat against this PC. */
export function validateNewSeat(body: unknown, host: SeatHostInfo | null): NewSeat {
  const b = (body ?? {}) as Record<string, unknown>;
  const iso = typeof b.iso === "string" ? b.iso.trim().replace(/^"|"$/g, "") : "";
  if (!/^[a-zA-Z]:\\.+\.iso$/i.test(iso) && !/^\\\\[^\\]+\\.+\.iso$/i.test(iso)) throw new Error("Give the full path of a Windows 10 or 11 .iso file on this PC");
  const maxCpus = Math.max(2, (host?.cpus ?? 64) - 2);
  const seat: NewSeat = {
    iso,
    memoryGb: Math.round(num(b.memoryGb, 4, 128, "Memory (GB)")),
    cpus: Math.round(num(b.cpus, 2, maxCpus, "Processors")),
    diskGb: Math.round(num(b.diskGb, 64, 4096, "Disk (GB)")),
    gpuShare: Math.round(num(b.gpuShare, 0.1, 0.9, "Graphics card share") * 100) / 100,
  };
  if (typeof b.gpu === "string" && b.gpu) {
    if (host && !host.gpus.some((g) => g.path === b.gpu)) throw new Error("That graphics card can't be partitioned");
    seat.gpu = b.gpu;
  }
  return seat;
}

/** Waits for the manager's answer to a request. */
export async function awaitAnswer(id: string, timeoutMs: number, pollMs = 1000): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const answer = deps.readResponse(id);
    if (answer) return answer;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error("The seat manager didn't answer in time (Settings > Extra seats shows what it's doing)");
}

async function send(action: string, body: Record<string, unknown> = {}): Promise<string> {
  const id = deps.request(action, body);
  await ensureManager();
  return id;
}

/** Hyper-V, GPU partitioning, the network switch and the games share. */
export async function prepareHost(opts: { allowGpuPolicy: boolean; storage?: string }): Promise<void> {
  const storage = typeof opts.storage === "string" ? opts.storage.trim() : "";
  if (storage && !/^[a-zA-Z]:\\/.test(storage)) throw new Error("The folder for the seats' disks must be a full path, like D:\\Seats");
  await send("prepare", { allowGpuPolicy: !!opts.allowGpuPolicy, storage, port: getSetting("port") });
}

export async function recheckHost(): Promise<void> {
  await send("check");
}

/** Starts building a seat. Returns its name. */
export async function createSeat(input: NewSeat): Promise<string> {
  const status = deps.readStatus();
  if (!status?.host?.ready) throw new Error(status?.host?.problems?.join(" ") || "This PC isn't ready for seats yet");
  const clientCert = deps.clientCert();
  if (!clientCert) throw new Error("Luma Arcade isn't paired with this PC's Sunshine yet, so a seat couldn't be paired either");
  const name = nextSeatName([...status.seats.map((s) => s.name), ...deps.paired().keys()]);
  await send("create", { name, ...input, clientCert, port: getSetting("port") });
  return name;
}

function checkName(name: string): string {
  if (!SEAT_NAME.test(name) || !/^Seat\d{1,2}$/.test(name)) throw new Error("No such seat");
  return name;
}

/** A build that failed carries on from the step it stopped at. */
export async function retrySeat(name: string): Promise<void> {
  const clientCert = deps.clientCert();
  await send("create", { name: checkName(name), clientCert, port: getSetting("port") });
}

/** Runs a seat's software steps again (ES-DE, Sunshine, helpers, pairing). */
export async function repairSeat(name: string): Promise<void> {
  const clientCert = deps.clientCert();
  await send("repair", { name: checkName(name), clientCert, port: getSetting("port") });
  pairingNote.delete(name);
}

export async function powerSeat(name: string, op: "start" | "stop" | "restart"): Promise<void> {
  if (!["start", "stop", "restart"].includes(op)) throw new Error("Unknown action");
  await send(op, { name: checkName(name) });
}

/**
 * Removes a seat. Players whose latest saves are on it get them brought
 * back to the main PC first (they'd be lost with its disk) - unless force,
 * when its copies are given up. Then it's unpaired, and its virtual machine
 * deleted (only one Luma Arcade made: others are just unpaired).
 */
export async function removeSeat(
  name: string,
  opts: { force?: boolean; players: Player[] }
): Promise<{ moved: string[]; lost: string[] }> {
  checkName(name);
  const moved: string[] = [];
  const failed: { player: Player; error: string }[] = [];
  for (const player of opts.players.filter((p) => lastPc(p.id) === name)) {
    try {
      await fetchTo(player, MAIN, listSeats());
      moved.push(player.name);
    } catch (err) {
      failed.push({ player, error: (err as Error).message });
    }
  }
  if (failed.length && !opts.force) {
    throw new Error(
      `Couldn't bring ${failed.map((f) => f.player.name).join(", ")}'s saves back from ${name} (${failed[0].error}). ` +
        `Start ${name} and try again, or remove it anyway and lose what they saved there.`
    );
  }
  for (const f of failed) setLastPc(f.player.id, MAIN);
  await deps.unpair(name);
  const status = deps.readStatus();
  if (status?.seats.find((s) => s.name === name)?.managed) await send("remove", { name });
  pairingNote.delete(name);
  return { moved, lost: failed.map((f) => f.player.name) };
}

/**
 * Pairs finished seats with moonlight-web-stream, and follows a seat whose
 * address changed (its network hands out addresses). Both restart the
 * streaming server, so they wait for nobody to be playing - unless now.
 */
export async function syncPairing(opts: { now?: boolean } = {}, log?: FastifyBaseLogger): Promise<string[]> {
  const status = deps.readStatus();
  if (!status) return [];
  const paired = deps.paired();
  const done: string[] = [];
  for (const seat of status.seats) {
    if (!seat.finished || !seat.serverCert || !seat.address || seat.vm !== "Running") continue;
    const known = paired.get(seat.name);
    if (known === seat.address) {
      pairingNote.delete(seat.name);
      continue;
    }
    if (!opts.now && deps.anyoneStreaming()) {
      pairingNote.set(seat.name, known ? `Its address changed to ${seat.address}: updated when nobody's playing` : "Paired as soon as nobody's playing (pairing restarts the streaming server)");
      continue;
    }
    await deps.pair({ name: seat.name, address: seat.address, httpPort: seat.httpPort || 47989, serverCert: seat.serverCert });
    pairingNote.delete(seat.name);
    log?.info({ seat: seat.name, address: seat.address }, known ? "seat's address updated" : "seat paired");
    done.push(seat.name);
  }
  return done;
}

let timer: NodeJS.Timeout | null = null;

/** Every minute, when there are seats: pairing and address changes. */
export function startSeatAdmin(log: FastifyBaseLogger): void {
  if (timer || !managerInstalled()) return;
  timer = setInterval(() => {
    const status = deps.readStatus();
    if (!status?.seats.length) return;
    void ensureManager()
      .then(() => syncPairing({}, log))
      .catch((err: Error) => log.warn({ err }, "seat pairing check failed"));
  }, 60_000);
  timer.unref();
}
