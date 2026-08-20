import { getSetting } from "../config/settings.js";
import { scanCustomApps } from "./customApps.js";
import { scanEpicLibrary } from "./epicScanner.js";
import { fetchGameMetadata } from "./igdb.js";
import { gamesMissingMetadata, setGameMetadata, upsertGame } from "./repo.js";
import { scanRomFolders } from "./romScanner.js";
import { scanSteamLibrary } from "./steamScanner.js";

export async function runLibraryScan(): Promise<void> {
  if (getSetting("steamEnabled")) {
    const steamGames = await scanSteamLibrary();
    for (const game of steamGames) {
      upsertGame({ source: "steam", ...game });
    }
  }

  if (getSetting("epicEnabled")) {
    const epicGames = scanEpicLibrary();
    for (const game of epicGames) {
      upsertGame({ source: "epic", ...game });
    }
  }

  if (getSetting("emulationEnabled")) {
    const romGames = scanRomFolders();
    for (const game of romGames) {
      upsertGame({ source: "emulation", ...game });
    }
  }

  if (getSetting("customAppsEnabled")) {
    const customGames = scanCustomApps();
    for (const game of customGames) {
      upsertGame({ source: "custom", ...game });
    }
  }

  await resolveMissingMetadata();
}

async function resolveMissingMetadata(): Promise<void> {
  const missing = gamesMissingMetadata();
  for (const game of missing) {
    const metadata = await fetchGameMetadata(game.title);
    setGameMetadata(game.id, metadata);
  }
}
