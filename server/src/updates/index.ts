// The Updates window (tray: "Check for updates…"): Luma Arcade itself plus
// everything Setup put on this PC (Sunshine, the tunnel, drivers, ES-DE,
// emulators). Luma Arcade's own version comes from updateCheck.ts; the rest
// from installer/scripts/update-components.ps1, which reuses Setup's
// download list, checksums and install steps.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkForUpdate } from "../remote/updateCheck.js";
import { applySelfUpdate, canSelfUpdate } from "../remote/selfUpdate.js";
import { dataPath, IS_WINDOWS } from "../platform.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// updates/ -> dist (or src) -> server -> the install (or the repo checkout)
const INSTALL_ROOT = path.join(__dirname, "..", "..", "..");

export type Mode = "tested" | "newest";
export type RowState = "ok" | "new" | "unknown" | "error" | "manual";

export interface UpdateRow {
  id: string;
  name: string;
  what: string;
  group: string;
  installed: string | null;
  target: string | null;
  state: RowState;
  /** Programs running from its folder: it can't be updated until they close. */
  busy: string[];
  /** What updating it does to people playing ("Ends any stream in progress"). */
  note: string | null;
  notesUrl: string | null;
  error: string | null;
}

export interface UpdateList {
  mode: Mode;
  checkedAt: string | null;
  rows: UpdateRow[];
  error?: string;
}

export interface JobItem {
  state: "queued" | "updating" | "restarting" | "done" | "failed";
  phase: string;
  message: string;
  version: string;
}

export interface JobStatus {
  running: boolean;
  started: string | null;
  items: Record<string, JobItem>;
  log: string[];
}

/** Sent by the tray's window, so it works without signing in. New every start. */
export const updatesKey = randomBytes(24).toString("base64url");

export function scriptPath(): string | null {
  for (const p of [
    path.join(INSTALL_ROOT, "setup", "update-components.ps1"),
    path.join(INSTALL_ROOT, "installer", "scripts", "update-components.ps1"),
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

const GROUP_ORDER = ["Luma Arcade", "Streaming", "Game library", "Emulators"];

interface ScriptComponent {
  id: string;
  name: string;
  what: string;
  group: string;
  installed: string | null;
  busy: string[] | string | null;
  note: string | null;
  target?: string;
  compare?: "same" | "older" | "newer" | "unknown";
  notes?: string | null;
  error?: string;
}

function runScript(args: string[], timeoutMs: number): Promise<string> {
  const script = scriptPath();
  if (!script) return Promise.reject(new Error("The updater script (update-components.ps1) isn't installed"));
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim().split(/\r?\n/).slice(-3).join(" ")));
        else resolve(stdout);
      },
    );
  });
}

function toArray(v: string[] | string | null | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

export function rowFromComponent(c: ScriptComponent): UpdateRow {
  let state: RowState = "unknown";
  if (c.error) state = "error";
  else if (c.compare === "older") state = "new";
  else if (c.compare === "same" || c.compare === "newer") state = "ok";
  return {
    id: c.id,
    name: c.name,
    what: c.what ?? "",
    group: c.group,
    installed: c.installed ?? null,
    target: c.target ?? null,
    state,
    busy: toArray(c.busy),
    note: c.note ?? null,
    notesUrl: c.notes ?? null,
    error: c.error ?? null,
  };
}

/** Was this copy installed by Setup (so its installer can upgrade it)? */
function installedBySetup(): boolean {
  return existsSync(path.join(INSTALL_ROOT, "Uninstall.exe"));
}

async function lumaRow(): Promise<UpdateRow> {
  const s = await checkForUpdate();
  const canUpdate = s.canApply || installedBySetup();
  let state: RowState = s.error ? "error" : s.updateAvailable ? "new" : "ok";
  if (state === "new" && !canUpdate) state = "manual";
  return {
    id: "luma",
    name: "Luma Arcade",
    what: "Website, sign-in, stream page",
    group: "Luma Arcade",
    installed: s.localVersion,
    target: s.latestVersion,
    state,
    busy: [],
    note: "Restarts Luma Arcade: players reconnect by themselves",
    notesUrl: s.downloadUrl,
    error: s.error ?? (state === "manual" ? "Update it with the installer from the release page" : null),
  };
}

function sortRows(rows: UpdateRow[]): UpdateRow[] {
  return rows.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
}

// --- the last check, kept across restarts (the tray's dot, "last checked")

const CACHE_FILE = () => dataPath("updates", "last-check.json");
let lastCheck: UpdateList | null = null;

function loadCache(): UpdateList | null {
  if (lastCheck) return lastCheck;
  try {
    lastCheck = JSON.parse(readFileSync(CACHE_FILE(), "utf-8")) as UpdateList;
  } catch {
    lastCheck = null;
  }
  return lastCheck;
}

function saveCache(list: UpdateList): void {
  lastCheck = list;
  try {
    mkdirSync(path.dirname(CACHE_FILE()), { recursive: true });
    writeFileSync(CACHE_FILE(), JSON.stringify(list));
  } catch {
    // Only a convenience.
  }
  for (const fn of listeners) fn(countUpdates(list));
}

export function countUpdates(list: UpdateList | null): number {
  return list ? list.rows.filter((r) => r.state === "new").length : 0;
}

const listeners = new Set<(count: number) => void>();
/** Called with the number of updates ready after every check. */
export function onUpdateCount(fn: (count: number) => void): void {
  listeners.add(fn);
  fn(countUpdates(loadCache()));
}

/** What's installed, with the last check's targets where there was one (no network). */
export async function listInstalled(mode: Mode): Promise<UpdateList> {
  const cached = loadCache();
  if (cached && cached.mode === mode) return cached;
  try {
    const out = JSON.parse(await runScript(["-Action", "list"], 60_000)) as { components: ScriptComponent[] };
    const rows = (out.components ?? []).map((c) => ({ ...rowFromComponent(c), state: "unknown" as RowState }));
    return { mode, checkedAt: null, rows: sortRows([await lumaRow(), ...rows]) };
  } catch (err) {
    return { mode, checkedAt: null, rows: [], error: (err as Error).message };
  }
}

let checking: Promise<UpdateList> | null = null;

/** Looks up what each would update to. ids: only those (the rest keep the last answer). */
export function checkUpdates(mode: Mode, ids?: string[]): Promise<UpdateList> {
  if (checking && !ids) return checking;
  const run = (async (): Promise<UpdateList> => {
    const args = ["-Action", "check"];
    if (mode === "newest") args.push("-Newest");
    const [out, luma] = await Promise.all([
      runScript(args, 5 * 60_000).then((s) => JSON.parse(s) as { components: ScriptComponent[] }),
      lumaRow(),
    ]);
    const fresh = sortRows([luma, ...(out.components ?? []).map(rowFromComponent)]);
    const previous = loadCache();
    const rows =
      ids && previous && previous.mode === mode
        ? previous.rows.map((r) => (ids.includes(r.id) ? fresh.find((f) => f.id === r.id) ?? r : r))
        : fresh;
    const list: UpdateList = { mode, checkedAt: new Date().toISOString(), rows };
    saveCache(list);
    return list;
  })();
  if (!ids) {
    checking = run;
    run.finally(() => (checking = null)).catch(() => {});
  }
  return run;
}

// --- updating

let job: { status: JobStatus; file: string | null; selfBuild: boolean } | null = null;

function readJobFile(file: string): Partial<JobStatus> | null {
  try {
    return JSON.parse(readFileSync(file, "utf-8").replace(/^\uFEFF/, "")) as Partial<JobStatus>;
  } catch {
    return null;
  }
}

export function jobStatus(): JobStatus {
  if (!job) return { running: false, started: null, items: {}, log: [] };
  const fromFile = job.file ? readJobFile(job.file) : null;
  if (fromFile) {
    const luma = job.selfBuild ? job.status.items.luma : undefined;
    job.status.items = { ...job.status.items, ...(fromFile.items ?? {}) };
    if (luma) job.status.items.luma = luma;
    job.status.log = [...(fromFile.log ?? []), ...job.status.log.filter((l) => l.startsWith("[build] "))];
  }
  return job.status;
}

/** Updates those, one after another. Luma Arcade goes last: it restarts. */
export function startUpdate(ids: string[], mode: Mode): JobStatus {
  if (job?.status.running) throw new Error("An update is already running");
  const others = ids.filter((id) => id !== "luma");
  const luma = ids.includes("luma");
  // A checkout to build from (this PC's development copy): pull and build
  // it here. A copy Setup installed: its installer upgrades it (the script).
  const selfBuild = luma && canSelfUpdate().ok;
  const scriptIds = selfBuild ? others : [...others, ...(luma ? ["luma"] : [])];

  const status: JobStatus = { running: true, started: new Date().toISOString(), items: {}, log: [] };
  for (const id of ids) status.items[id] = { state: "queued", phase: "Waiting", message: "", version: "" };
  const file = scriptIds.length ? path.join(os.tmpdir(), `luma-updates-${Date.now()}.json`) : null;
  job = { status, file, selfBuild };

  const finish = async () => {
    if (selfBuild) {
      status.items.luma = { state: "updating", phase: "Building", message: "", version: "" };
      const r = await applySelfUpdate();
      status.items.luma = r.ok
        ? { state: "done", phase: "", message: "Restart Luma Arcade from the tray to use it", version: "" }
        : { state: "failed", phase: "", message: r.error ?? "Build failed", version: "" };
      status.log.push(...r.log.map((l) => `[build] ${l.split(/\r?\n/)[0]}`));
    }
    jobStatus();
    status.running = false;
    // The installed versions changed: look again (quietly).
    checkUpdates(mode).catch(() => {});
  };

  if (!file) {
    void finish();
    return status;
  }
  const script = scriptPath();
  if (!script) {
    for (const id of scriptIds) status.items[id] = { state: "failed", phase: "", message: "The updater script isn't installed", version: "" };
    status.running = false;
    return status;
  }
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", "update", "-Only", scriptIds.join(","), "-StatusFile", file];
  if (mode === "newest") args.push("-Newest");
  const child = spawn("powershell.exe", args, { windowsHide: true, stdio: "ignore" });
  child.on("exit", () => void finish());
  child.on("error", (err) => {
    for (const id of scriptIds) status.items[id] = { state: "failed", phase: "", message: err.message, version: "" };
    void finish();
  });
  return status;
}

// --- once a day, quietly (the tray shows a dot when something's ready)

const DAY = 24 * 60 * 60_000;
export function startDailyUpdateChecks(): void {
  if (!IS_WINDOWS || !scriptPath()) return;
  const tick = () => {
    const last = loadCache();
    const age = last?.checkedAt ? Date.now() - Date.parse(last.checkedAt) : Infinity;
    if (age > 20 * 60 * 60_000 && !job?.status.running) checkUpdates("tested").catch(() => {});
  };
  setTimeout(tick, 3 * 60_000).unref();
  setInterval(tick, DAY / 4).unref();
}
