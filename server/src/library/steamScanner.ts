import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Registry from "winreg";

export interface ScannedGame {
  externalId: string;
  title: string;
  launchTarget: string; // steam appid
}

function getSteamInstallPath(): Promise<string> {
  return new Promise((resolve) => {
    const key = new Registry({ hive: Registry.HKCU, key: "\\Software\\Valve\\Steam" });
    key.get("SteamPath", (err, item) => {
      if (!err && item?.value) {
        resolve(item.value.replace(/\//g, "\\"));
      } else {
        resolve("C:\\Program Files (x86)\\Steam");
      }
    });
  });
}

/**
 * Hand-rolled extraction rather than a full VDF (Valve KeyValues) parser —
 * we only need a handful of top-level string fields out of files we don't
 * otherwise need to round-trip or write back.
 */
function extractField(vdf: string, field: string): string[] {
  const re = new RegExp(`"${field}"\\s+"([^"]*)"`, "gi");
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(vdf))) {
    values.push(match[1]);
  }
  return values;
}

export async function scanSteamLibrary(): Promise<ScannedGame[]> {
  const steamPath = await getSteamInstallPath();
  const libraryFoldersVdf = path.join(steamPath, "steamapps", "libraryfolders.vdf");
  if (!existsSync(libraryFoldersVdf)) return [];

  const vdf = readFileSync(libraryFoldersVdf, "utf-8");
  const libraryPaths = extractField(vdf, "path");
  // The Steam install path itself is always an implicit library.
  const allLibraries = Array.from(new Set([steamPath, ...libraryPaths]));

  const games: ScannedGame[] = [];

  for (const libraryPath of allLibraries) {
    const steamappsDir = path.join(libraryPath, "steamapps");
    if (!existsSync(steamappsDir)) continue;

    const manifestFiles = readdirSync(steamappsDir).filter(
      (f) => f.startsWith("appmanifest_") && f.endsWith(".acf")
    );

    for (const file of manifestFiles) {
      const acf = readFileSync(path.join(steamappsDir, file), "utf-8");
      const [appid] = extractField(acf, "appid");
      const [name] = extractField(acf, "name");
      if (!appid || !name) continue;
      games.push({ externalId: appid, title: name, launchTarget: appid });
    }
  }

  return games;
}
