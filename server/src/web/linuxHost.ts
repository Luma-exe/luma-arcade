import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { HealthCheck } from "./routes/health.js";

// The Linux side of Host health (Linux support is in early testing): Sunshine
// as a systemd user service, its config in ~/.config/sunshine, controllers
// through /dev/uinput.

const run = promisify(execFile);

export const LINUX_SUNSHINE_CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "sunshine");

async function ok(file: string, args: string[]): Promise<boolean> {
  try {
    await run(file, args, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Sunshine runs as the signed-in user: its systemd user service, or started by hand. */
export async function sunshineRunningLinux(): Promise<boolean> {
  return (await ok("systemctl", ["--user", "is-active", "--quiet", "sunshine"])) || (await ok("pgrep", ["-x", "sunshine"]));
}

export async function restartSunshineLinux(): Promise<void> {
  await run("systemctl", ["--user", "restart", "sunshine"], { timeout: 60_000 });
}

export function earlyTestingCheck(): HealthCheck {
  return {
    id: "linux",
    label: "Linux support",
    status: "warn",
    detail:
      "Very early testing: streaming, accounts, turns, co-op and guest links should work but are barely tested on Linux. The Home button, lockdown, per-player saves, " +
      "game tracking and PC games import are Windows-only for now. Please report what you find.",
  };
}

/** Sunshine turns players' controllers into virtual pads through uinput. */
export function uinputCheck(device = "/dev/uinput"): HealthCheck {
  const base = { id: "uinput", label: "Virtual controllers" };
  if (!existsSync(device)) {
    return { ...base, status: "error", detail: `${device} is missing: load the uinput module (sudo modprobe uinput) so players' controllers work` };
  }
  try {
    accessSync(device, constants.W_OK);
    return { ...base, status: "ok", detail: `${device} is writable, so Sunshine can add players' controllers` };
  } catch {
    return {
      ...base,
      status: "warn",
      detail: `Can't write ${device} as this user: Sunshine's udev rule (or the input group) is needed for players' controllers`,
    };
  }
}

/** What the video can be encoded with: NVIDIA's NVENC, or VA-API (AMD, Intel). */
export async function encoderCheckLinux(): Promise<HealthCheck> {
  const base = { id: "encoder-linux", label: "Graphics for encoding" };
  if (await ok("nvidia-smi", ["-L"])) return { ...base, status: "ok", detail: "NVIDIA graphics found (NVENC)" };
  if (existsSync("/dev/dri/renderD128")) return { ...base, status: "ok", detail: "A GPU render device was found (VA-API, for AMD or Intel)" };
  return { ...base, status: "warn", detail: "No GPU found for encoding: Sunshine would use the processor, which lags" };
}

/** Disks to watch on Linux: the system, and the home folder (games usually live there). */
export const LINUX_DISKS = [
  { root: "/", use: "system" },
  { root: os.homedir(), use: "home" },
];
