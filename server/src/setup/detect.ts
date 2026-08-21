import { existsSync } from "node:fs";
import path from "node:path";
import { getSetting } from "../config/settings.js";

export interface DetectedDependencies {
  sunshineConfigDir: string | null;
  esdeExePath: string | null;
  moonlightWebStreamExePath: string | null;
}

// Same candidate locations the old installer's DetectEsde already probed —
// ES-DE's own installer doesn't always land in the same place depending on
// per-user vs machine-wide install choices.
const ESDE_CANDIDATES = [
  "C:\\Program Files\\ES-DE\\ES-DE.exe",
  "C:\\Program Files (x86)\\ES-DE\\ES-DE.exe",
  path.join(process.env.LOCALAPPDATA ?? "", "Programs", "ES-DE", "ES-DE.exe"),
];

const SUNSHINE_CONFIG_CANDIDATES = [
  "C:\\Program Files\\Sunshine\\config",
  "C:\\Program Files (x86)\\Sunshine\\config",
];

export function detectDependencies(): DetectedDependencies {
  const sunshineConfigDir = SUNSHINE_CONFIG_CANDIDATES.find((p) => existsSync(p)) ?? null;
  const esdeExePath = ESDE_CANDIDATES.find((p) => existsSync(p)) ?? null;

  // The installer stages moonlight-web-stream as a sibling of LumaArcade
  // itself; if the user already pointed Settings at a different build,
  // trust that over guessing.
  const configuredPath = getSetting("moonlightWebStreamPath");
  const installerDefault = path.join(
    process.env.LOCALAPPDATA ?? "",
    "Programs",
    "LumaArcade",
    "moonlight-web-stream",
    "web-server.exe"
  );
  const moonlightWebStreamExePath =
    (configuredPath && existsSync(configuredPath) && configuredPath) ||
    (existsSync(installerDefault) && installerDefault) ||
    null;

  return { sunshineConfigDir, esdeExePath, moonlightWebStreamExePath };
}
