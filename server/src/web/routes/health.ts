import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getSetting } from "../../config/settings.js";
import { moonlightProcess } from "../../remote/moonlightWebStream.js";
import { requireAuth } from "../session.js";

const run = promisify(execFile);

// Sunshine's default install location; its config and log live here.
const SUNSHINE_CONFIG_DIR = "C:\\Program Files\\Sunshine\\config";
const SUNSHINE_HTTP_PORT = 47989;
const XUSB_DRIVER = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "drivers", "xusb22.sys");

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
    const found = [...log.matchAll(/Found (\S+) encoder: (\S+)/g)].map((m) => `${m[1]} (${m[2]})`);
    checks.push({
      id: "encoder",
      label: "Video encoder",
      status: found.length > 0 ? "ok" : "warn",
      detail: found.length > 0 ? found.join(", ") : "No encoder listed in Sunshine's current log yet",
    });
  } catch {}

  return checks;
}

function checkControllers(): HealthCheck {
  const gamepad = (readSunshineConf().gamepad ?? "auto").toLowerCase();
  const hasXusb = existsSync(XUSB_DRIVER);
  const needsXusb = gamepad === "auto" || gamepad === "x360";

  if (needsXusb && !hasXusb) {
    return {
      id: "controllers",
      label: "Virtual controllers",
      status: "error",
      detail: `Sunshine emulates Xbox 360 pads (gamepad = ${gamepad}) but the Xbox 360 driver (xusb22.sys) isn't installed, so games won't see them. Install it, or set gamepad = ds4.`,
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
    ]);
    const [sunshine, moonlight, consoleSession, esde] = results;
    return { checks: [...sunshine, moonlight, checkControllers(), consoleSession, esde] };
  });
}
