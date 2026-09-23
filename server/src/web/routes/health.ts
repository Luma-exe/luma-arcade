import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statfsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getSetting } from "../../config/settings.js";
import { moonlightProcess } from "../../remote/moonlightWebStream.js";
import { requireAuth } from "../session.js";

const run = promisify(execFile);

// Sunshine's default install location; its config and log live here.
const SUNSHINE_CONFIG_DIR = "C:\\Program Files\\Sunshine\\config";
const SUNSHINE_HTTP_PORT = 47989;
// The Xbox 360 controller driver: xusb22.sys ships with Windows 10/11 client,
// xusb21.sys comes from Microsoft's standalone package (what Windows Server
// needs, since it ships neither).
const XUSB_DRIVERS = ["xusb22.sys", "xusb21.sys"].map((file) =>
  path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "drivers", file)
);

type Status = "ok" | "warn" | "error";
export interface HealthCheck {
  id: string;
  label: string;
  status: Status;
  detail: string;
}

async function output(file: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(file, args, { windowsHide: true, timeout: 5000 });
    return stdout;
  } catch (err) {
    // qwinsta exits non-zero in some sessions but still prints the table
    return (err as { stdout?: string }).stdout ?? "";
  }
}

function readSunshineConf(): Record<string, string> {
  try {
    const text = readFileSync(path.join(SUNSHINE_CONFIG_DIR, "sunshine.conf"), "utf8");
    const conf: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([\w]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) conf[m[1]] = m[2];
    }
    return conf;
  } catch {
    return {};
  }
}

async function checkSunshine(): Promise<HealthCheck[]> {
  const svc = await output("sc.exe", ["query", "SunshineService"]);
  const running = /STATE\s*:\s*\d+\s+RUNNING/.test(svc);

  let reachable = false;
  try {
    const res = await fetch(`http://127.0.0.1:${SUNSHINE_HTTP_PORT}/serverinfo`, {
      signal: AbortSignal.timeout(2000),
    });
    reachable = res.status < 500;
  } catch {}

  const checks: HealthCheck[] = [
    {
      id: "sunshine",
      label: "Sunshine",
      status: running && reachable ? "ok" : "error",
      detail: !running
        ? "SunshineService isn't running"
        : reachable
          ? "Service running and answering"
          : `Service running but not answering on port ${SUNSHINE_HTTP_PORT}`,
    },
  ];

  // Sunshine logs which hardware encoders it found at startup.
  try {
    const log = readFileSync(path.join(SUNSHINE_CONFIG_DIR, "sunshine.log"), "utf8");
    // Sunshine re-probes (and re-logs) its encoders on some reconnects
    const found = [...new Set([...log.matchAll(/Found (\S+) encoder: (\S+)/g)].map((m) => `${m[1]} (${m[2]})`))];
    checks.push({
      id: "encoder",
      label: "Video encoder",
      status: found.length > 0 ? "ok" : "warn",
      detail: found.length > 0 ? found.join(", ") : "No encoder listed in Sunshine's current log yet",
    });
  } catch {}

  return checks;
}

/** A freshly installed driver sits in the driver store until the first
 * matching device appears; only then is its .sys copied into drivers\. */
function xusbInDriverStore(): boolean {
  const store = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "DriverStore", "FileRepository");
  try {
    return readdirSync(store).some((dir) => /^xusb2[12]\.inf_amd64_/i.test(dir));
  } catch {
    return false;
  }
}

function checkControllers(): HealthCheck {
  const gamepad = (readSunshineConf().gamepad ?? "auto").toLowerCase();
  const hasXusb = XUSB_DRIVERS.some((file) => existsSync(file)) || xusbInDriverStore();
  const needsXusb = gamepad === "auto" || gamepad === "x360";

  if (needsXusb && !hasXusb) {
    return {
      id: "controllers",
      label: "Virtual controllers",
      status: "error",
      detail: `Sunshine emulates Xbox 360 pads (gamepad = ${gamepad}) but the Xbox 360 driver (xusb21/xusb22.sys) isn't installed, so games won't see them. Install it, or set gamepad = ds4.`,
    };
  }
  return {
    id: "controllers",
    label: "Virtual controllers",
    status: gamepad === "ds4" && !hasXusb ? "warn" : "ok",
    detail:
      gamepad === "ds4" && !hasXusb
        ? "Emulating PS4 controllers (works in ES-DE/RetroArch). Xbox-only PC games need the Xbox 360 driver."
        : `Emulating ${gamepad} controllers${hasXusb ? ", Xbox 360 driver installed" : ""}`,
  };
}

async function checkConsoleSession(): Promise<HealthCheck> {
  const table = await output("qwinsta.exe", []);
  // e.g. ">console           Arcade                    1  Active"
  const line = table.split(/\r?\n/).find((l) => /^\s*>?console\s/i.test(l));
  const m = line && /^\s*>?console\s+(\S+)?\s+(\d+)\s+(\w+)/i.exec(line);
  const user = m?.[1];
  const state = m?.[3] ?? "unknown";

  if (!user || /^\d+$/.test(user)) {
    return {
      id: "console",
      label: "Console login",
      status: "error",
      detail:
        "Nobody is logged into the PC's console, so Sunshine can't capture the screen or launch apps. Log in locally, or reconnect with mstsc /admin.",
    };
  }
  return {
    id: "console",
    label: "Console login",
    status: state.toLowerCase() === "active" ? "ok" : "warn",
    detail: `${user} is logged in (${state})`,
  };
}

async function checkEsDe(): Promise<HealthCheck> {
  const list = await output("tasklist.exe", ["/FI", "IMAGENAME eq ES-DE.exe", "/NH"]);
  const running = /ES-DE\.exe/i.test(list);
  return {
    id: "esde",
    label: "ES-DE",
    // Not running is normal: Sunshine launches it when a stream starts.
    status: "ok",
    detail: running ? "Running" : "Not running (Sunshine starts it when you connect)",
  };
}

/** Runs moonlight-web-stream's ICE server script exactly as it does at
 * stream start, and reports whether it hands out a TURN relay (needed on
 * networks that block direct connections) or only STUN. */
async function checkTurn(): Promise<HealthCheck> {
  const exe = getSetting("moonlightWebStreamPath");
  const script = exe && path.join(path.dirname(exe), "server", "turn_ice_script.bat");
  if (!script || !existsSync(script)) {
    return { id: "turn", label: "Remote play relay", status: "warn", detail: "No TURN script found next to moonlight-web-stream" };
  }

  let servers: { urls: string[] }[] = [];
  let failure = "";
  try {
    const { stdout, stderr } = await run("cmd.exe", ["/c", script], {
      cwd: path.dirname(exe),
      windowsHide: true,
      timeout: 15000,
    });
    servers = JSON.parse(stdout);
    failure = stderr.trim();
  } catch (err) {
    failure = (err as Error).message;
  }

  if (servers.some((s) => s.urls.some((u) => u.startsWith("turn")))) {
    return { id: "turn", label: "Remote play relay", status: "ok", detail: "Cloudflare TURN credentials issued" };
  }
  return {
    id: "turn",
    label: "Remote play relay",
    status: "warn",
    detail: failure
      ? `TURN unavailable (${failure}), streams will use direct connections only`
      : "No TURN key set in moonlight-web-stream's server/cloudflare_turn.json - streams may fail on mobile data or strict networks",
  };
}

async function checkMoonlight(): Promise<HealthCheck> {
  const port = getSetting("moonlightWebStreamPort");
  let reachable = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    reachable = res.status < 500;
  } catch {}
  const lastError = moonlightProcess.getLastError();
  return {
    id: "moonlight",
    label: "moonlight-web-stream",
    status: reachable ? "ok" : "error",
    detail: reachable
      ? "Answering"
      : `${moonlightProcess.isRunning() ? "Running but not answering" : "Not running"}${lastError ? ` - ${lastError}` : ""}`,
  };
}

/** Whether someone is streaming right now, from Sunshine's connect/disconnect
 * log lines (its own API needs its separate admin login). */
function checkStream(): HealthCheck {
  let last: RegExpMatchArray | undefined;
  try {
    const log = readFileSync(path.join(SUNSHINE_CONFIG_DIR, "sunshine.log"), "utf8");
    last = [...log.matchAll(/^\[[\d-]+ (\d{2}:\d{2}):[\d.]+\]: Info: CLIENT (CONNECTED|DISCONNECTED)/gm)].at(-1);
  } catch {}
  const detail = !last
    ? "No stream since Sunshine last started"
    : last[2] === "CONNECTED"
      ? `Someone is streaming now (since ${last[1]})`
      : `No active stream (last one ended ${last[1]})`;
  return { id: "stream", label: "Stream", status: "ok", detail };
}

const GB = 1024 ** 3;
// The system drive, the drive with ES-DE's ROMs/emulators/BIOS, and the
// separate disk the nightly save backup (below) writes to.
const DISKS = [
  { root: "C:\\", use: "system" },
  { root: "G:\\", use: "games" },
  { root: "E:\\", use: "save backups" },
];

function checkDiskSpace(): HealthCheck {
  const parts: string[] = [];
  let status: Status = "ok";
  for (const { root, use } of DISKS) {
    try {
      const s = statfsSync(root);
      const free = s.bavail * s.bsize;
      const pct = (free / (s.blocks * s.bsize)) * 100;
      // Emulators write shader caches and saves as they go; a full games
      // drive shows up as crashes, not as a clear "disk full" error.
      if (free < 5 * GB || pct < 3) status = "error";
      else if ((pct < 10 || free < 20 * GB) && status === "ok") status = "warn";
      parts.push(`${root.slice(0, 2)} (${use}) ${Math.round(free / GB)} GB free, ${Math.round(pct)}%`);
    } catch {
      parts.push(`${root.slice(0, 2)} (${use}) not found`);
      if (status === "ok") status = "warn";
    }
  }
  return { id: "disk", label: "Disk space", status, detail: parts.join(" · ") };
}

// ES-DE's emulators folder and the account ES-DE (and so every emulator)
// runs as; emulators that aren't in portable mode keep data in its profile.
const EMULATORS = "G:\\ES-DE\\Emulators";
const ARCADE_ROAMING = "C:\\Users\\Arcade\\AppData\\Roaming";

function iniValue(file: string, key: string): string | undefined {
  try {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "m").exec(readFileSync(file, "utf8"));
    return m?.[1].replace(/^'(.*)'$/, "$1");
  } catch {
    return undefined;
  }
}

function nonEmptyDir(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/** The BIOS/firmware/key files each console's emulator can't start games
 * without, checked where that emulator is actually configured to look. */
function checkBiosFiles(): HealthCheck {
  const pcsx2Ini = path.join(EMULATORS, "PCSX2-Qt", "inis", "PCSX2.ini");
  const pcsx2Dir = iniValue(pcsx2Ini, "Bios");
  const pcsx2File = iniValue(pcsx2Ini, "BIOS");
  const xemuToml = path.join(ARCADE_ROAMING, "xemu", "xemu", "xemu.toml");
  const xemuFiles = ["bootrom_path", "flashrom_path", "hdd_path"].map((k) => iniValue(xemuToml, k));

  const required: [string, boolean][] = [
    ["PS1 BIOS", nonEmptyDir(path.join(EMULATORS, "duckstation", "bios"))],
    ["PS2 BIOS", !!pcsx2Dir && !!pcsx2File && existsSync(path.join(pcsx2Dir, pcsx2File))],
    ["PS3 firmware", existsSync(path.join(EMULATORS, "RPCS3", "dev_flash", "vsh", "module", "vsh.self"))],
    ["Vita firmware", existsSync(path.join(EMULATORS, "Vita3K", "vs0", "vsh"))],
    ["Switch keys", existsSync(path.join(EMULATORS, "eden", "user", "keys", "prod.keys"))],
    ["Switch firmware", nonEmptyDir(path.join(EMULATORS, "eden", "user", "nand", "system", "Contents", "registered"))],
    ["Xbox BIOS", xemuFiles.every((f) => !!f && existsSync(f))],
    ["Wii U keys", existsSync(path.join(ARCADE_ROAMING, "Cemu", "keys.txt"))],
  ];
  const missing = required.filter(([, ok]) => !ok).map(([name]) => name);
  return {
    id: "bios",
    label: "BIOS & firmware",
    status: missing.length ? "warn" : "ok",
    detail: missing.length
      ? `Missing: ${missing.join(", ")} - games for those systems won't start`
      : `All present (${required.map(([name]) => name).join(", ")})`,
  };
}

// Written by E:\GameSaveBackups\backup-saves.ps1 ("Game Save Backup" task)
const BACKUP_STATUS = "E:\\GameSaveBackups\\last-run.json";

function checkSaveBackup(): HealthCheck {
  try {
    const run = JSON.parse(readFileSync(BACKUP_STATUS, "utf8").replace(/^\uFEFF/, "")) as {
      time: string;
      failed: string[] | string | null;
      sizeMB: number;
    };
    const hours = (Date.now() - new Date(run.time).getTime()) / 3_600_000;
    const failed = ([] as string[]).concat(run.failed ?? []);
    const age = hours < 1 ? "under an hour" : hours < 48 ? `${Math.round(hours)} hours` : `${Math.round(hours / 24)} days`;
    return {
      id: "backup",
      label: "Save backup",
      // nightly at 4am, so anything past a day and a half means runs are failing
      status: failed.length || hours > 36 ? "warn" : "ok",
      detail: failed.length
        ? `Last backup ${age} ago couldn't copy: ${failed.join(", ")}`
        : `Last backup ${age} ago (${run.sizeMB} MB)${hours > 36 ? " - the nightly task isn't running" : ""}`,
    };
  } catch {
    return {
      id: "backup",
      label: "Save backup",
      status: "warn",
      detail: "No save backup has run yet (scheduled task \"Game Save Backup\")",
    };
  }
}

/** One-shot diagnosis of everything outside LumaArcade that has to be right
 * for a stream to work - the checks that used to mean digging through
 * Sunshine/ES-DE logs and Device Manager by hand. */
export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/api/health/host", { preHandler: requireAuth }, async () => {
    const results = await Promise.all([
      checkSunshine(),
      checkMoonlight(),
      checkConsoleSession(),
      checkEsDe(),
      checkTurn(),
    ]);
    const [sunshine, moonlight, consoleSession, esde, turn] = results;
    return {
      checks: [
        checkStream(),
        ...sunshine,
        moonlight,
        checkControllers(),
        consoleSession,
        esde,
        turn,
        checkBiosFiles(),
        checkDiskSpace(),
        checkSaveBackup(),
      ],
    };
  });
}
