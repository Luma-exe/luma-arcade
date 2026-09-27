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

interface MoonlightData {
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
