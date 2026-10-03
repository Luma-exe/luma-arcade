import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requireAuth } from "../session.js";
import { IS_WINDOWS } from "../../platform.js";

const run = promisify(execFile);

// ES-DE launches every emulator with the game's path on its command line, and
// its ROM folders are named after the system (G:\ES-DE\ROMs\<system>\...), so
// the newest process with such a path says which console is being played.
// The stream page's touch controls use this to pick a layout.
const ROM_DIR = /\\ROMs\\([a-z0-9_-]+)\\([^"\\]+?)(?:"|\s-|\s*$)/i;

// For emulators started without a ROM path (Steam shortcuts, opened by hand).
const EXE_SYSTEMS: Record<string, string> = {
  "xenia_canary.exe": "xbox360",
  "xenia.exe": "xbox360",
  "xemu.exe": "xbox",
  "eden.exe": "switch",
  "yuzu.exe": "switch",
  "ryujinx.exe": "switch",
  "citron.exe": "switch",
  "cemu.exe": "wiiu",
  "rpcs3.exe": "ps3",
  "pcsx2-qt.exe": "ps2",
  "pcsx2.exe": "ps2",
  "shadps4.exe": "ps4",
  "duckstation-qt-x64-releaseltcg.exe": "psx",
  "ppssppwindows64.exe": "psp",
  "vita3k.exe": "psvita",
  "azahar.exe": "n3ds",
  "citra-qt.exe": "n3ds",
  "melonds.exe": "nds",
};

const LAUNCHERS = new Set(["es-de.exe"]);

export interface ActiveInput {
  ok: boolean;
  error?: string;
  /** ES-DE system name ("wii", "switch", "ps4"...), "pc" for Steam games,
   * "menu" when only a launcher is up, null when nothing was found. */
  system: string | null;
  source: "rom" | "steam" | "exe" | "launcher" | "none";
  process?: string;
  title?: string;
}

interface ProcessRow {
  Name: string;
  ExecutablePath: string | null;
  CommandLine: string | null;
  Created: number;
}

const PS_QUERY =
  "Get-CimInstance Win32_Process | Where-Object { $_.SessionId -ne 0 } | " +
  "Select-Object Name,ExecutablePath,CommandLine,@{n='Created';e={[int64]($_.CreationDate - [datetime]'1970-01-01').TotalSeconds}} | " +
  "ConvertTo-Json -Compress";

async function listProcesses(): Promise<ProcessRow[]> {
  // (Windows only so far: on Linux nothing is detected.)
  if (!IS_WINDOWS) return [];
  const { stdout } = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", PS_QUERY],
    { windowsHide: true, timeout: 8000, maxBuffer: 16 * 1024 * 1024 }
  );
  const parsed = JSON.parse(stdout || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

function detect(processes: ProcessRow[]): ActiveInput {
  const newestFirst = [...processes].sort((a, b) => b.Created - a.Created);

  for (const p of newestFirst) {
    const m = p.CommandLine ? ROM_DIR.exec(p.CommandLine) : null;
    if (m && m[1].toLowerCase() !== "emulators") {
      return {
        ok: true,
        system: m[1].toLowerCase(),
        source: "rom",
        process: p.Name,
        title: m[2].replace(/\.[a-z0-9]{1,5}$/i, "").replace(/\s*[([].*$/, "").trim(),
      };
    }
  }

  for (const p of newestFirst) {
    const exe = p.ExecutablePath ?? "";
    if (/\\steamapps\\common\\/i.test(exe)) {
      const folder = /\\steamapps\\common\\([^\\]+)/i.exec(exe);
      return { ok: true, system: "pc", source: "steam", process: p.Name, title: folder?.[1] };
    }
  }

  for (const p of newestFirst) {
    const system = EXE_SYSTEMS[p.Name.toLowerCase()];
    if (system) return { ok: true, system, source: "exe", process: p.Name };
  }

  for (const p of newestFirst) {
    if (LAUNCHERS.has(p.Name.toLowerCase())) {
      return { ok: true, system: "menu", source: "launcher", process: p.Name };
    }
  }
  if (newestFirst.some((p) => /\\steam\.exe$/i.test(p.ExecutablePath ?? "") && /bigpicture/i.test(p.CommandLine ?? ""))) {
    return { ok: true, system: "menu", source: "launcher", process: "steam.exe" };
  }

  return { ok: true, system: null, source: "none" };
}

// Every open stream polls this; one process scan serves them all.
const CACHE_MS = 2500;
let cached: { at: number; value: ActiveInput } | null = null;
let inflight: Promise<ActiveInput> | null = null;

export async function getActiveInput(): Promise<ActiveInput> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  if (!inflight) {
    inflight = listProcesses()
      .then(detect)
      .catch((err): ActiveInput => ({ ok: false, error: (err as Error).message, system: null, source: "none" }))
      .then((value) => {
        cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** What's being played on the host, for the touch controls' auto layout. */
export async function registerInputRoutes(app: FastifyInstance) {
  app.get("/api/input/active", { preHandler: requireAuth }, async () => getActiveInput());
}
