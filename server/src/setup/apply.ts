import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setSettings } from "../config/settings.js";
import { detectDependencies, type DetectedDependencies } from "./detect.js";

export interface SetupResult {
  detected: DetectedDependencies;
  esdeAddedToSunshine: boolean;
  moonlightPathUpdated: boolean;
  notes: string[];
}

/** Writes JSON without a UTF-8 BOM. PowerShell's `-Encoding utf8` (and, it
 * turns out, plenty of other tooling) defaults to UTF-8 *with* BOM on
 * Windows — harmless to most parsers but fatal to moonlight-web-stream's
 * Rust/serde_json config loader, which errors on byte 0 rather than
 * skipping it. Confirmed live against a real install, not theoretical. */
function writeJsonNoBom(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: "utf-8" });
}

/** Adds ES-DE to Sunshine's apps.json (if both were found and it isn't
 * there already) and points LumaArcade's own settings at a detected
 * moonlight-web-stream build. Deliberately does not touch sunshine.conf's
 * display/resolution settings or attempt Sunshine/moonlight-web-stream
 * account creation or pairing — those need a human in a browser once each,
 * this only wires up what's purely mechanical. */
export function runSetup(): SetupResult {
  const detected = detectDependencies();
  const notes: string[] = [];
  let esdeAddedToSunshine = false;
  let moonlightPathUpdated = false;

  if (detected.sunshineConfigDir && detected.esdeExePath) {
    const appsPath = path.join(detected.sunshineConfigDir, "apps.json");
    try {
      const raw = readFileSync(appsPath, "utf-8");
      const parsed = JSON.parse(raw) as { env?: object; apps?: Array<{ name: string }> };
      parsed.apps = parsed.apps ?? [];
      const existing = parsed.apps.find((a) => a.name === "ES-DE") as
        | (Record<string, unknown> & { name: string })
        | undefined;

      if (!existing) {
        parsed.apps.push({
          name: "ES-DE",
          cmd: detected.esdeExePath,
          "auto-detach": true,
        } as any);
        writeJsonNoBom(appsPath, parsed);
        esdeAddedToSunshine = true;
        notes.push(`Added ES-DE to Sunshine's app list (${appsPath}).`);
      } else {
        notes.push("ES-DE is already in Sunshine's app list.");
      }
    } catch (err) {
      notes.push(`Couldn't read/update Sunshine's apps.json: ${(err as Error).message}`);
    }
  } else {
    if (!detected.sunshineConfigDir) notes.push("Sunshine install not found.");
    if (!detected.esdeExePath) notes.push("ES-DE install not found.");
  }

  if (detected.moonlightWebStreamExePath) {
    setSettings({
      moonlightWebStreamPath: detected.moonlightWebStreamExePath,
      moonlightAutoStart: true,
    });
    moonlightPathUpdated = true;
    notes.push(`Pointed Settings at moonlight-web-stream (${detected.moonlightWebStreamExePath}).`);
  } else {
    notes.push("moonlight-web-stream install not found.");
  }

  return { detected, esdeAddedToSunshine, moonlightPathUpdated, notes };
}
