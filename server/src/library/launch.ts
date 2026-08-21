import { exec } from "node:child_process";
import { getGame, markPlayed } from "./repo.js";
import { spawnDetached } from "./processUtils.js";
import { listRomFolders } from "./romScanner.js";

export interface LaunchResult {
  ok: boolean;
  error?: string;
  pid?: number;
}

export function launchGame(id: number): LaunchResult {
  const game = getGame(id);
  if (!game) return { ok: false, error: "game not found" };

  markPlayed(id);

  switch (game.source) {
    case "steam": {
      exec(`start steam://rungameid/${game.launch_target}`);
      return { ok: true };
    }

    case "epic": {
      const [namespace, catalogItemId, appName] = game.launch_target.split(":");
      const url =
        `com.epicgames.launcher://apps/${encodeURIComponent(namespace)}%3A` +
        `${encodeURIComponent(catalogItemId)}%3A${encodeURIComponent(appName)}` +
        `?action=launch&silent=true`;
      exec(`start "" "${url}"`);
      return { ok: true };
    }

    case "emulation": {
      const folder = listRomFolders().find((f) => f.console === game.console);
      if (!folder) return { ok: false, error: `no emulator configured for ${game.console}` };
      const args = folder.launch_args_template
        .replace("{rom}", game.launch_target)
        .split(" ")
        .filter(Boolean);
      const child = spawnDetached(folder.emulator_exe_path, args);
      return { ok: true, pid: child.pid };
    }

    case "custom": {
      const child = spawnDetached(game.launch_target, []);
      return { ok: true, pid: child.pid };
    }

    default:
      return { ok: false, error: "unknown source" };
  }
}
