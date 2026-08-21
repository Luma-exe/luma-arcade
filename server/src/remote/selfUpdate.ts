import { execFile } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSetting } from "../config/settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// remote/ -> dist -> server -> install root
const INSTALL_ROOT = path.join(__dirname, "..", "..", "..");

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // shell: true — npm on Windows is npm.cmd, which execFile can't launch
    // directly without a shell to interpret it.
    execFile(cmd, args, { cwd, maxBuffer: 20 * 1024 * 1024, shell: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

export interface SelfUpdateResult {
  ok: boolean;
  log: string[];
  error?: string;
}

/** Pulls the configured dev-tree checkout, rebuilds it, and copies the
 * fresh client/server dist over this install — the same manual sequence
 * used throughout development, just automated behind one call. Requires
 * `devTreePath` to be set (see settings.ts for why this isn't attempted
 * against an arbitrary installed copy with no source tree available). */
export async function applySelfUpdate(): Promise<SelfUpdateResult> {
  const devTreePath = getSetting("devTreePath");
  const log: string[] = [];

  if (!devTreePath) {
    return {
      ok: false,
      log,
      error: "No dev tree path configured in Settings — nothing to build from.",
    };
  }
  if (!existsSync(path.join(devTreePath, ".git"))) {
    return { ok: false, log, error: `${devTreePath} doesn't look like a git checkout.` };
  }

  try {
    log.push("Pulling latest...");
    log.push(await run("git", ["pull"], devTreePath));

    log.push("Installing dependencies...");
    log.push(await run("npm", ["install"], devTreePath));

    log.push("Building...");
    log.push(await run("npm", ["run", "build"], devTreePath));

    log.push("Deploying build...");
    cpSync(path.join(devTreePath, "client", "dist"), path.join(INSTALL_ROOT, "client", "dist"), {
      recursive: true,
    });
    cpSync(path.join(devTreePath, "server", "dist"), path.join(INSTALL_ROOT, "server", "dist"), {
      recursive: true,
    });

    log.push("Done — restart LumaArcade from the tray icon to apply the update.");
    return { ok: true, log };
  } catch (err) {
    return { ok: false, log, error: (err as Error).message };
  }
}
