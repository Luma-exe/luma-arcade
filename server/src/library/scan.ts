import { getSetting } from "../config/settings.js";
import { scanCustomApps } from "./customApps.js";
import { scanEpicLibrary } from "./epicScanner.js";
import { fetchBoxArtUrl } from "./igdb.js";
import { gamesMissingBoxArt, setBoxArt, upsertGame } from "./repo.js";
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

  await resolveMissingBoxArt();
}

async function resolveMissingBoxArt(): Promise<void> {
  const missing = gamesMissingBoxArt();
  for (const game of missing) {
    const url = await fetchBoxArtUrl(game.title);
    if (url) setBoxArt(game.id, url);
  }
}
