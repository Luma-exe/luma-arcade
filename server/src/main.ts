import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initDb } from "./db/index.js";
import { getAllSettings } from "./config/settings.js";
import { getDb } from "./db/index.js";
import { createServer } from "./web/server.js";
import { startTray } from "./tray/index.js";
import { moonlightProcess, syncMoonlightWithSettings } from "./remote/moonlightWebStream.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const dbPath = path.join(__dirname, "..", "luma-arcade.db");
  initDb(dbPath);

  const cookieSecret = getOrCreateCookieSecret();
  const { port } = getAllSettings();

  await createServer({ port, cookieSecret });

  const portalUrl = `http://localhost:${port}`;
  console.log(`LumaArcade listening at ${portalUrl}`);

  syncMoonlightWithSettings();

  // Double-clicking the Start Menu shortcut only starts this background
  // server with no window — open the portal automatically so it doesn't
  // look like nothing happened. Skipped during `npm run dev:server` (set
  // via that script) since restarting on every file change would otherwise
  // spam browser tabs.
  if (process.env.LUMA_DEV !== "1") {
    // execFile + an args array, not exec()'s shell-interpreted string — the
    // port (and therefore portalUrl) comes from settings.ts, which now
    // validates it's an integer before it's ever saved, but there's no
    // reason to leave this shell-interpretable regardless of that. "start"
    // is itself a cmd.exe builtin, not a real executable, hence /c start.
    execFile("cmd.exe", ["/c", "start", "", portalUrl]);
  }

  startTray({
    onQuit: () => {
      moonlightProcess.stop();
      process.exit(0);
    },
  });
}

function getOrCreateCookieSecret(): string {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'cookieSecret'").get() as
    | { value: string }
    | undefined;
  if (row) return JSON.parse(row.value);

  const secret = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO settings (key, value) VALUES ('cookieSecret', ?)").run(
    JSON.stringify(secret)
  );
  return secret;
}

process.on("SIGINT", () => {
  moonlightProcess.stop();
  process.exit(0);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
