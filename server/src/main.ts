import path from "node:path";
import { randomBytes } from "node:crypto";
import { exec } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initDb } from "./db/index.js";
import { getAllSettings, setSettings, type AppSettings } from "./config/settings.js";
import { getDb } from "./db/index.js";
import { createServer } from "./web/server.js";
import { startTray } from "./tray/index.js";
import { producerProcess } from "./capture/browserProducer.js";
import { cloudflaredProcess, syncCloudflaredWithSettings } from "./remote/cloudflared.js";
import { coturnProcess, syncCoturnWithSettings } from "./remote/coturn.js";
import { promoteToConsoleSessionIfNeeded } from "./remote/consoleSession.js";
import { onRdpChange, startRdpWatch } from "./remote/rdpWatch.js";
import { restartCaptureForCurrentSession } from "./web/routes/stream.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const dbPath = path.join(__dirname, "..", "luma-arcade.db");
  initDb(dbPath);
  applyInitialSettingsMarker();

  const cookieSecret = getOrCreateCookieSecret();
  const { port, launchMode } = getAllSettings();

  await createServer({ port, cookieSecret });

  const portalUrl = `http://localhost:${port}`;
  console.log(`LumaArcade listening at ${portalUrl}`);

  syncCloudflaredWithSettings();
  syncCoturnWithSettings();
  promoteToConsoleSessionIfNeeded();
  startRdpWatch();

  // DXGI Desktop Duplication -- what the video producer's screen capture
  // relies on -- cannot run at all while an active Remote Desktop session
  // holds the display: confirmed live via the producer's own logs, which
  // flood with "DxgiDuplicatorController failed to capture desktop...
  // Duplication failed" for the entire time an RDP session is connected.
  // Capture only ever produces one real frame right at the RDP connect/
  // disconnect edge (whichever moment duplication is still momentarily
  // available), then fails silently for the rest of the session -- exactly
  // the "frozen on whatever it looked like when I last connected" symptom.
  // There is no fixing that; duplication and an active RDP session are
  // mutually exclusive on this API. The correct behavior is to stop
  // capturing the moment RDP connects (no point burning CPU on a capture
  // that can only fail) and only restart it once RDP disconnects, when
  // duplication becomes available again.
  onRdpChange((connected) => {
    void (async () => {
      const wasRunning = await producerProcess.isRunning();
      await producerProcess.stop();
      if (wasRunning && !connected) await restartCaptureForCurrentSession(port);
    })();
  });

  // Double-clicking the Start Menu shortcut only starts this background
  // server with no window — open the portal automatically so it doesn't
  // look like nothing happened. Skipped during `npm run dev:server` (set
  // via that script) since restarting on every file change would otherwise
  // spam browser tabs, and skipped entirely in ES-DE mode: that mode is for
  // remote/headless boxes where the whole point is streaming to a *different*
  // machine, and this self-opened tab was found live to silently compete
  // with the real remote viewer for the single global capture pipeline —
  // both trying to start/own a session at once, each killing the other's
  // GStreamer process mid-negotiation.
  if (process.env.LUMA_DEV !== "1" && launchMode !== "esde") {
    exec(`start ${portalUrl}`);
  }

  startTray({
    portalUrl,
    onQuit: () => {
      void (async () => {
        await producerProcess.stop();
        cloudflaredProcess.stop();
        coturnProcess.stop();
        process.exit(0);
      })();
    },
  });
}

/** The installer can't write to the SQLite settings table directly (no
 * bundled SQLite plugin for NSIS), so the finish-page launch-mode choice
 * and any ES-DE path it discovered are dropped here as a plain JSON file
 * instead — applied once on the app's first-ever boot, then deleted so it
 * can never re-apply and stomp on settings the user changes afterward. */
function applyInitialSettingsMarker(): void {
  // server/dist -> server -> installRoot
  const markerPath = path.join(__dirname, "..", "..", "initial-settings.json");
  if (!existsSync(markerPath)) return;

  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf-8")) as Partial<AppSettings>;
    setSettings(parsed);
    console.log("[main] applied initial settings from installer:", parsed);
  } catch (err) {
    console.error("[main] failed to apply initial-settings.json:", err);
  } finally {
    rmSync(markerPath, { force: true });
  }
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
  void (async () => {
    await producerProcess.stop();
    cloudflaredProcess.stop();
    coturnProcess.stop();
    process.exit(0);
  })();
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
