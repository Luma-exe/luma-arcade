import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ScannedGame } from "./steamScanner.js";

const MANIFESTS_DIR = "C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests";

interface EpicItemManifest {
  DisplayName: string;
  CatalogNamespace: string;
  CatalogItemId: string;
  AppName: string;
}

export function scanEpicLibrary(): ScannedGame[] {
  if (!existsSync(MANIFESTS_DIR)) return [];

  const games: ScannedGame[] = [];
  const itemFiles = readdirSync(MANIFESTS_DIR).filter((f) => f.endsWith(".item"));

  for (const file of itemFiles) {
    try {
      const manifest = JSON.parse(
        readFileSync(path.join(MANIFESTS_DIR, file), "utf-8")
      ) as EpicItemManifest;
      if (!manifest.DisplayName || !manifest.AppName) continue;

      // launch_target packs the three IDs needed to build the
      // com.epicgames.launcher:// URL at launch time.
      const launchTarget = `${manifest.CatalogNamespace}:${manifest.CatalogItemId}:${manifest.AppName}`;
      games.push({
        externalId: manifest.AppName,
        title: manifest.DisplayName,
        launchTarget,
      });
    } catch {
      // Skip unreadable/malformed manifest files rather than failing the whole scan.
    }
  }

  return games;
}
