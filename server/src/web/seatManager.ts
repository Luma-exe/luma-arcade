import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { DATA_DIR, IS_WINDOWS } from "../platform.js";

// Talking to host/seat-manager.ps1, which does the extra seats' Hyper-V work
// as SYSTEM: a request is a file in seats\requests, its answer a file in
// seats\responses, and seats\status.json is what it last saw. Used by the
// settings page (seatAdmin.ts) and by saves moving to and from a seat
// (saveSync.ts).

const run = promisify(execFile);
export const SEATS_DIR = process.env.LUMA_SEATS_DIR || path.join(DATA_DIR, "seats");
const TASK = "\\LumaArcade\\Seats";
/** status.json older than this: the manager isn't running. */
export const STALE_MS = 45_000;

export interface ManagerAnswer {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as T;
  } catch {
    return null;
  }
}

/** Setup installed the seat manager here (installer/scripts/install-host.ps1). */
export function managerInstalled(): boolean {
  return IS_WINDOWS && existsSync(path.join(DATA_DIR, "seat-manager.ps1")) && existsSync(path.join(SEATS_DIR, "requests"));
}

export function readStatusFile<T>(): T | null {
  return readJson<T>(path.join(SEATS_DIR, "status.json"));
}

/** Drops a request for the manager. Returns its id (its answer's name). */
export function writeRequest(action: string, body: Record<string, unknown>): string {
  const id = randomUUID();
  const dir = path.join(SEATS_DIR, "requests");
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${Date.now()}-${id}.tmp`);
  writeFileSync(tmp, JSON.stringify({ ...body, action, id }));
  // The manager only picks up .json files: never a half-written one.
  renameSync(tmp, tmp.replace(/\.tmp$/, ".json"));
  return id;
}

export function readResponse(id: string): ManagerAnswer | null {
  const file = path.join(SEATS_DIR, "responses", `${id}.json`);
  const answer = readJson<ManagerAnswer>(file);
  if (answer) rmSync(file, { force: true });
  return answer;
}

export async function startManagerTask(): Promise<void> {
  await run("schtasks.exe", ["/run", "/tn", TASK], { windowsHide: true, timeout: 10_000 });
}

let lastStart = 0;

/** Starts the manager if it isn't running (status.json gone stale). */
export async function wakeManager(now = Date.now()): Promise<boolean> {
  const status = readStatusFile<{ updated: string }>();
  const fresh = !!status && now - Date.parse(status.updated) < STALE_MS;
  if (!fresh && now - lastStart > 30_000) {
    lastStart = now;
    await startManagerTask().catch(() => {});
  }
  return fresh;
}

/** A request and its answer: throws the manager's error. */
export async function askManager(action: string, body: Record<string, unknown>, timeoutMs: number): Promise<ManagerAnswer> {
  const id = writeRequest(action, body);
  await wakeManager();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const answer = readResponse(id);
    if (answer) {
      if (!answer.ok) throw new Error(answer.error || `${action} failed`);
      return answer;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`The seat manager didn't finish ${action} in time`);
}
