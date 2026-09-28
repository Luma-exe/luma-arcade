import path from "node:path";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initDb } from "./db/index.js";
import { getAllSettings } from "./config/settings.js";
import { createServer } from "./web/server.js";
import { startTray } from "./tray/index.js";
import { moonlightProcess, syncMoonlightWithSettings } from "./remote/moonlightWebStream.js";
import { initPlayLog } from "./web/playLog.js";
import { explainPortInUse } from "./portCheck.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const dbPath = path.join(__dirname, "..", "luma-arcade.db");
  initDb(dbPath);

  initPlayLog();
  const { port } = getAllSettings();

  try {
    await createServer({ port });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(await explainPortInUse(port));
    }
    throw err;
  }

  const portalUrl = `http://localhost:${port}`;
  console.log(`LumaArcade listening at ${portalUrl}`);

  syncMoonlightWithSettings();

  // Double-clicking the Start Menu shortcut only starts this background
  // server with no window — open the portal automatically so it doesn't
  // look like nothing happened. Skipped during `npm run dev:server` (set
  // via that script) since restarting on every file change would otherwise
  // spam browser tabs.
  if (process.env.LUMA_DEV !== "1") {
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
