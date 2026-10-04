import { randomInt } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getSetting } from "../config/settings.js";
import { moonlightProcess, syncMoonlightWithSettings } from "./moonlightWebStream.js";

// moonlight-web-stream keeps users, roles and paired hosts in
// server/data.json next to web-server.exe. Its API can't give a paired host
// to another user (a new host has to pair again), so copying devices edits
// that file directly, with the process stopped so it can't overwrite the
// change. Pairing keys never leave this module.

export interface MoonlightHost {
  owner: number | null;
  address: string;
  http_port: number;
  pair_info?: unknown;
  cache?: { name?: string; mac?: string | null };
}

export interface MoonlightData {
  users: Record<string, { name: string; role_id: number }>;
  hosts: Record<string, MoonlightHost>;
  roles: Record<string, { name: string }>;
  [key: string]: unknown;
}

export interface DeviceInfo {
  id: number;
  name: string;
  address: string;
  httpPort: number;
  /** user id, or null when every user can use it */
  owner: number | null;
  paired: boolean;
}

export function dataPath(): string {
  return path.join(path.dirname(getSetting("moonlightWebStreamPath")), "server", "data.json");
}

export function readData(): MoonlightData {
  return JSON.parse(readFileSync(dataPath(), "utf8")) as MoonlightData;
}

export function listDevices(data = readData()): DeviceInfo[] {
  return Object.entries(data.hosts ?? {}).map(([id, h]) => ({
    id: Number(id),
    name: h.cache?.name || h.address,
    address: h.address,
    httpPort: h.http_port,
    owner: h.owner ?? null,
    paired: !!h.pair_info,
  }));
}

export function listUsers(data = readData()): { id: number; name: string; roleId: number }[] {
  return Object.entries(data.users ?? {}).map(([id, u]) => ({ id: Number(id), name: u.name, roleId: u.role_id }));
}

async function waitForMoonlight(timeoutMs: number): Promise<boolean> {
  const port = getSetting("moonlightWebStreamPort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
      if (res.status < 500) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

let queue: Promise<unknown> = Promise.resolve();

/** Stop moonlight-web-stream, change data.json, start it again. Streams in
 * progress drop and everyone has to sign in again. */
export function editData<T>(change: (data: MoonlightData) => T): Promise<T> {
  const job = queue.then(async () => {
    await moonlightProcess.stopAndWait();
    const file = dataPath();
    try {
      const data = readData();
      const result = change(data);
      const backup = `${file}.bak-luma`;
      if (existsSync(file)) copyFileSync(file, backup);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, file);
      return result;
    } finally {
      syncMoonlightWithSettings();
      await waitForMoonlight(20_000);
    }
  });
  queue = job.catch(() => {});
  return job;
}

function newHostId(data: MoonlightData): string {
  let id: string;
  do {
    id = String(randomInt(1, 2 ** 32 - 1));
  } while (data.hosts[id]);
  return id;
}

function sameDevice(a: MoonlightHost, b: MoonlightHost): boolean {
  return a.address === b.address && a.http_port === b.http_port;
}

/** Give each user their own copy of a paired host (same pairing). Users
 * who already have that host are skipped. Returns how many copies were made. */
export function copyDevice(data: MoonlightData, hostId: number, userIds: number[]): number {
  const source = data.hosts[String(hostId)];
  if (!source) throw new Error("That device doesn't exist");
  let made = 0;
  for (const userId of userIds) {
    if (!data.users[String(userId)]) continue;
    const already = Object.values(data.hosts).some(
      (h) => sameDevice(h, source) && (h.owner === userId || h.owner === null)
    );
    if (already) continue;
    data.hosts[newHostId(data)] = { ...structuredClone(source), owner: userId };
    made++;
  }
  return made;
}

export function copyAllDevices(data: MoonlightData, fromUserId: number, toUserId: number): number {
  const ids = Object.entries(data.hosts)
    .filter(([, h]) => h.owner === fromUserId)
    .map(([id]) => Number(id));
  return ids.reduce((n, id) => n + copyDevice(data, id, [toUserId]), 0);
}

export function setDeviceOwner(data: MoonlightData, hostId: number, owner: number | null): void {
  const host = data.hosts[String(hostId)];
  if (!host) throw new Error("That device doesn't exist");
  if (owner !== null && !data.users[String(owner)]) throw new Error("That user doesn't exist");
  host.owner = owner;
}

export function deleteDevice(data: MoonlightData, hostId: number): void {
  if (!data.hosts[String(hostId)]) throw new Error("That device doesn't exist");
  delete data.hosts[String(hostId)];
}

// --- extra seats (web/seatAdmin.ts)

const SEAT_HOST = /^seat\s*\d+$/i;

/** Paired seats by name, with the address moonlight-web-stream uses. */
export function seatPairing(data: MoonlightData): Map<string, string> {
  const seats = new Map<string, string>();
  for (const h of Object.values(data.hosts ?? {})) {
    const name = h.cache?.name;
    if (name && SEAT_HOST.test(name) && h.pair_info) seats.set(name, h.address);
  }
  return seats;
}

/**
 * A seat paired without a PIN: it trusts the client certificate this PC's
 * Sunshine was paired with (host/seat-guest.ps1 added it to its devices),
 * so its entry is that pairing with the seat's own certificate. Everyone can
 * use it. Already there: its address (and certificate) are brought up to date.
 */
export function upsertSeatHost(
  data: MoonlightData,
  seat: { name: string; address: string; httpPort: number; serverCert: string }
): void {
  const existing = Object.values(data.hosts).filter((h) => h.cache?.name === seat.name);
  if (existing.length) {
    for (const h of existing) {
      h.address = seat.address;
      h.http_port = seat.httpPort;
      h.pair_info = { ...(h.pair_info as object), server_certificate: seat.serverCert };
    }
    return;
  }
  const main = Object.values(data.hosts).find((h) => /^(localhost|127\.0\.0\.1|::1)$/.test(h.address) && h.pair_info);
  const pair = main?.pair_info as { client_private_key?: string; client_certificate?: string } | undefined;
  if (!pair?.client_private_key || !pair.client_certificate) throw new Error("This PC isn't paired with its own Sunshine, so there's no certificate to pair the seat with");
  data.hosts[newHostId(data)] = {
    owner: null,
    address: seat.address,
    http_port: seat.httpPort,
    pair_info: {
      client_private_key: pair.client_private_key,
      client_certificate: pair.client_certificate,
      server_certificate: seat.serverCert,
    },
    cache: { name: seat.name, mac: null },
  };
}

/** Every copy of a seat, gone from everyone's devices. Returns how many. */
export function removeSeatHosts(data: MoonlightData, name: string): number {
  let n = 0;
  for (const [id, h] of Object.entries(data.hosts)) {
    if (h.cache?.name === name) {
      delete data.hosts[id];
      n++;
    }
  }
  return n;
}
