import { existsSync } from "node:fs";
import path from "node:path";
import { getSetting, setSetting } from "./settings.js";
import { MOONLIGHT_BINARY } from "../platform.js";

/** Where the installer puts moonlight-web-stream, next to the server folder. */
export function bundledMoonlightPath(installRoot: string): string {
  return path.join(installRoot, "moonlight-web-stream", MOONLIGHT_BINARY);
}

/**
 * A fresh install from the installer ships moonlight-web-stream: use it
 * (and start it with LumaArcade) unless a path was already set by hand.
 * Returns the path it picked, or null when it left the settings alone.
 */
export function useBundledMoonlight(installRoot: string): string | null {
  if (getSetting("moonlightWebStreamPath")) return null;
  const exe = bundledMoonlightPath(installRoot);
  if (!existsSync(exe)) return null;
  setSetting("moonlightWebStreamPath", exe);
  setSetting("moonlightAutoStart", true);
  return exe;
}
