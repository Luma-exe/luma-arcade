import path from "node:path";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initDb } from "./db/index.js";
import { getAllSettings } from "./config/settings.js";
import { createServer } from "./web/server.js";
import { startTray } from "./tray/index.js";
import { moonlightProcess, syncMoonlightWithSettings } from "./remote/moonlightWebStream.js";
import { initPlayLog, nameUnnamedApps } from "./web/playLog.js";
import { explainPortInUse } from "./portCheck.js";
import { restoreOwner } from "./web/sessions.js";
import { sunshineAppName } from "./web/sunshine.js";
import { startGameTracking } from "./web/games.js";
import { startWatchdog } from "./web/watchdog.js";
import { startLockdown } from "./web/lockdown.js";
import { startIdleChecks } from "./web/idle.js";
import { runHome } from "./web/routes/home.js";
import { timestampStderr } from "./process/stderrTimestamps.js";
import { useBundledMoonlight } from "./config/bundled.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  timestampStderr();
  const serverDir = path.join(__dirname, "..");
  const dbPath = path.join(serverDir, "luma-arcade.db");
  initDb(dbPath);
  // Installed with the Windows installer: server\dist\main.js -> the install folder.
  const bundled = useBundledMoonlight(path.join(__dirname, "..", ".."));
  if (bundled) console.log(`Using the bundled moonlight-web-stream at ${bundled}`);
  const owner = restoreOwner();
  if (owner) console.log(`Game on the PC still belongs to ${owner.name}`);

  initPlayLog();
  // Sunshine's app list, for naming streams (and old unnamed rows).
  void sunshineAppName(0)
    .then(() => nameUnnamedApps(sunshineAppName))
    .catch(() => {});
  const { port } = getAllSettings();

  let httpsPort: number | null = null;
  try {
    const server = await createServer({ port, serverDir });
    httpsPort = server.httpsPort;
    startWatchdog(server.app.log);
    startLockdown(server.app.log);
    startIdleChecks(server.app.log);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(await explainPortInUse(port));
    }
    throw err;
  }

  const portalUrl = `http://localhost:${port}`;
  console.log(`LumaArcade listening at ${portalUrl}`);
  if (httpsPort) console.log(`HTTPS for the home network at https://localhost:${httpsPort}`);

  syncMoonlightWithSettings();

  // What's played inside ES-DE; closes a game nobody came back to by
  // closing its window (emulators save on a normal exit) and going back to
  // ES-DE, like the stream page's Home button.
  startGameTracking((pid) => runHome({ action: "go", launcher: "es-de", close: true, pid, hwnd: null }, 75_000));

  // Double-clicking the Start Menu shortcut only starts this background
  // server with no window — open the portal automatically so it doesn't
  // look like nothing happened. Skipped during `npm run dev:server` (set
  // via that script) since restarting on every file change would otherwise
  // spam browser tabs. Started at sign-in (--background, the installer's
  // autostart), nobody asked for it: on a streamed desktop it would pop up
  // in front of the game.
  if (process.env.LUMA_DEV !== "1" && !process.argv.includes("--background")) {
    exec(`start ${portalUrl}`);
  }

  startTray({
    portalUrl,
    onQuit: () => {
      moonlightProcess.stop();
      process.exit(0);
    },
  });
}

process.on("SIGINT", () => {
  moonlightProcess.stop();
  process.exit(0);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
