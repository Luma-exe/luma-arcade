import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Registry from "winreg";

// Session-0-isolated Windows Services can't do screen capture or SendInput,
// so "start with Windows" is a per-user Run-key entry (runs in the logon
// session), not a service install.
const RUN_KEY = new Registry({
  hive: Registry.HKCU,
  key: "\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
});

const VALUE_NAME = "LumaArcade";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the silent-launch .vbs the installer stages next to server/client
 * (see installer/build.mjs) — launching it directly (rather than node.exe)
 * avoids a console window flashing on every logon. */
export function getLauncherCommand(): string {
  // server/dist/autostart -> server/dist -> server -> installRoot
  const installRoot = path.join(__dirname, "..", "..", "..");
  const vbsPath = path.join(installRoot, "LumaArcade.vbs");
  if (!existsSync(vbsPath)) {
    throw new Error(
      "Auto-start requires the installed app (LumaArcade.vbs launcher not found) — " +
        "not available when running from source."
    );
  }
  return `wscript.exe "${vbsPath}"`;
}

export function enableAutoStart(): Promise<void> {
  return new Promise((resolve, reject) => {
    RUN_KEY.set(VALUE_NAME, Registry.REG_SZ, getLauncherCommand(), (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function disableAutoStart(): Promise<void> {
  return new Promise((resolve, reject) => {
    RUN_KEY.remove(VALUE_NAME, (err) => {
      // "value not found" is not an error for our purposes.
      if (err && !/unable to find/i.test(err.message)) reject(err);
      else resolve();
    });
  });
}

export function isAutoStartEnabled(): Promise<boolean> {
  return new Promise((resolve) => {
    RUN_KEY.get(VALUE_NAME, (err, item) => {
      resolve(!err && !!item);
    });
  });
}
