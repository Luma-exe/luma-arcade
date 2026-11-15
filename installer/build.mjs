import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signFiles } from "./sign.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const stagingDir = path.join(__dirname, "staging");
const outputDir = path.join(__dirname, "output");

function run(cmd, cwd, env = process.env) {
  console.log(`> ${cmd}${cwd ? `  (cwd=${cwd})` : ""}`);
  execSync(cmd, { cwd, stdio: "inherit", shell: true, env });
}

// The Node.js that gets bundled: LUMA_NODE_EXE, else the node running this
// script (so CI's setup-node version is what ships).
function resolveNode() {
  const exe = process.env.LUMA_NODE_EXE || process.execPath;
  if (!existsSync(exe)) throw new Error(`node.exe not found at ${exe} — check LUMA_NODE_EXE`);
  return exe;
}

// makensis: LUMA_MAKENSIS, then PATH, then the registry, then the default folders.
function resolveMakensis() {
  const fromEnv = process.env.LUMA_MAKENSIS;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`LUMA_MAKENSIS points at ${fromEnv}, which doesn't exist`);
    return fromEnv;
  }
  const tried = [];
  try {
    const found = execSync("where makensis.exe", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)[0]
      .trim();
    if (found && existsSync(found)) return found;
  } catch {
    tried.push("PATH");
  }
  for (const key of ["HKLM\\SOFTWARE\\WOW6432Node\\NSIS", "HKLM\\SOFTWARE\\NSIS"]) {
    try {
      const out = execSync(`reg query "${key}" /ve`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
      const m = out.match(/REG_SZ\s+(.+)/);
      const exe = m && path.join(m[1].trim(), "makensis.exe");
      if (exe && existsSync(exe)) return exe;
    } catch {
      /* key not present */
    }
  }
  tried.push("registry");
  for (const base of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, "C:\\Program Files (x86)"]) {
    const exe = base && path.join(base, "NSIS", "makensis.exe");
    if (exe && existsSync(exe)) return exe;
  }
  tried.push("default install folders");
  throw new Error(`makensis.exe not found (looked in ${tried.join(", ")}). Install NSIS or set LUMA_MAKENSIS.`);
}

// The customized moonlight-web-stream build (its own repo,
// moonlight-web-stream-luma): web-server.exe, streamer.exe, static\, server\.
// LUMA_MOONLIGHT_DIR (MOONLIGHT_PACKAGE_DIR still works), else the sibling folder.
const MOONLIGHT_DIR =
  process.env.LUMA_MOONLIGHT_DIR ||
  process.env.MOONLIGHT_PACKAGE_DIR ||
  path.join(repoRoot, "..", "moonlight-web-stream-bin", "package");

// Fail before the slow steps if anything the build needs is missing.
const NODE_EXE = resolveNode();
const MAKENSIS = resolveMakensis();
for (const f of ["web-server.exe", "streamer.exe", "static", path.join("server", "config.json")]) {
  if (!existsSync(path.join(MOONLIGHT_DIR, f))) {
    throw new Error(
      `moonlight-web-stream package incomplete: ${path.join(MOONLIGHT_DIR, f)} is missing.\n` +
        "Set LUMA_MOONLIGHT_DIR to the folder holding web-server.exe, streamer.exe, static\\ and server\\ " +
        "(default: ..\\moonlight-web-stream-bin\\package next to this repo)."
    );
  }
}
if (!existsSync(path.join(repoRoot, "THIRD-PARTY-NOTICES.md"))) {
  throw new Error("THIRD-PARTY-NOTICES.md is missing — run `npm run notices`");
}
console.log(`node.exe:   ${NODE_EXE}\nmakensis:   ${MAKENSIS}\nmoonlight:  ${MOONLIGHT_DIR}`);

// LumaArcade's "/" leads into moonlight-web-stream under /stream, whose
// sign-in is the only login. ES-DE, the emulators and Sunshine aren't
// bundled: the installer downloads them (installer/scripts).
console.log("=== 1. Building server ===");
run("npm run build -w server", repoRoot);

console.log("=== 2. Staging files ===");
if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });
mkdirSync(path.join(stagingDir, "server"), { recursive: true });

cpSync(path.join(repoRoot, "server", "dist"), path.join(stagingDir, "server", "dist"), {
  recursive: true,
});
cpSync(path.join(repoRoot, "server", "assets"), path.join(stagingDir, "server", "assets"), {
  recursive: true,
});
cpSync(
  path.join(repoRoot, "server", "package.json"),
  path.join(stagingDir, "server", "package.json")
);

console.log("=== 3. Installing production dependencies into staged copy ===");
run("npm install --omit=dev --no-audit --no-fund", path.join(stagingDir, "server"));

// Load the native module with the same Node that gets bundled, instead of
// looking for its binary on disk: better-sqlite3 now ships prebuilds/
// rather than build/Release, and newer npm can skip install scripts unless
// they're approved.
try {
  run(`"${NODE_EXE}" -e "new (require('better-sqlite3'))(':memory:').close()"`, path.join(stagingDir, "server"));
} catch {
  throw new Error("better-sqlite3 won't load from the staged node_modules — packaging would produce a broken installer");
}

console.log("=== 4. Staging moonlight-web-stream ===");
const moonlightStage = path.join(stagingDir, "moonlight-web-stream");
mkdirSync(path.join(moonlightStage, "server"), { recursive: true });
for (const exe of ["web-server.exe", "streamer.exe"]) {
  cpSync(path.join(MOONLIGHT_DIR, exe), path.join(moonlightStage, exe));
}
cpSync(path.join(MOONLIGHT_DIR, "static"), path.join(moonlightStage, "static"), {
  recursive: true,
  // Local backups of edited files never ship.
  filter: (src) => !/[\\/]_backup|\.bak-/.test(src),
});
// Only the config and the TURN script from server\: never data.json (this
// PC's users and pairing key), cloudflare_turn.json (an API token) or backups.
for (const file of ["turn_ice_script.bat", "turn_ice_script.ps1"]) {
  cpSync(path.join(MOONLIGHT_DIR, "server", file), path.join(moonlightStage, "server", file));
}
const config = JSON.parse(readFileSync(path.join(MOONLIGHT_DIR, "server", "config.json"), "utf-8"));
// A fresh install is first opened over plain http (localhost / home
// network), where secure-only cookies would make signing in impossible.
config.web_server.session_cookie_secure = false;
config.moonlight.pair_device_name = "LumaArcade";
// Setup's first-run.mjs creates the admin by signing in first, then makes
// the paired PC everyone's.
config.web_server.first_login_create_admin = true;
config.web_server.first_login_assign_global_hosts = true;
// Installed as config.json only when there's none: an upgrade keeps the
// user's own changes.
writeFileSync(path.join(moonlightStage, "server", "config.default.json"), JSON.stringify(config, null, 4));

console.log("=== 4b. Staging the PC-side helper scripts ===");
// Installed into C:\ProgramData\LumaArcade by installer/scripts/install-host.ps1.
// sync-steam*.ps1 aren't included: they're for one PC's Steam library.
const hostStage = path.join(stagingDir, "host");
mkdirSync(hostStage, { recursive: true });
const hostFiles = [
  [MOONLIGHT_DIR, ["home.ps1", "lockdown.ps1", "lockdown-shells.ps1", "focus-app.ps1", "stream-start.ps1", "esde-game-events.ps1", "vdd_settings.xml"]],
  // seat-*.ps1: extra seats (seat-manager.ps1 runs as SYSTEM, seat-guest.ps1 inside each seat).
  [repoRoot, ["profiles.ps1", "esde-game-started.ps1", "esde-keepalive.ps1", "emulator-window.ps1", "sync-pc-games.ps1", "seat-manager.ps1", "seat-guest.ps1", "seat-sync.ps1", "arcade-backup.ps1"]],
];
for (const [root, files] of hostFiles) {
  for (const file of files) cpSync(path.join(root, "host", file), path.join(hostStage, file));
}
if (!existsSync(path.join(__dirname, "scripts", "versions.json"))) {
  throw new Error("installer/scripts/versions.json is missing — run installer/scripts/update-versions.ps1");
}

console.log("=== 5. Copying portable node.exe ===");
cpSync(NODE_EXE, path.join(stagingDir, "node.exe"));

// Installed by the setup from the staging root.
cpSync(path.join(repoRoot, "THIRD-PARTY-NOTICES.md"), path.join(stagingDir, "THIRD-PARTY-NOTICES.md"));

console.log("=== 6. Writing launcher script ===");
writeFileSync(
  path.join(stagingDir, "LumaArcade.vbs"),
  [
    'Set shell = CreateObject("WScript.Shell")',
    'shell.CurrentDirectory = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\\") - 1)',
    // Arguments pass through (--background: started at sign-in, don't open a browser).
    'args = ""',
    "For Each a In WScript.Arguments",
    '  args = args & " " & a',
    "Next",
    'shell.Run """node.exe"" server\\dist\\main.js" & args, 0, False',
  ].join("\r\n"),
  "utf-8"
);

console.log("=== 6b. Signing bundled executables ===");
// Off unless configured (installer/sign.mjs); node.exe is already signed by the Node.js project.
signFiles([
  path.join(moonlightStage, "web-server.exe"),
  path.join(moonlightStage, "streamer.exe"),
]);

console.log("=== 7. Running makensis ===");
mkdirSync(outputDir, { recursive: true });
const { version } = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
// The .nsi runs `node sign.mjs` (!uninstfinalize): make sure that finds the same node.
const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
const nsisEnv = { ...process.env, [pathKey]: `${path.dirname(NODE_EXE)}${path.delimiter}${process.env[pathKey] ?? ""}` };
run(`"${MAKENSIS}" /DAPP_VERSION=${version} "${path.join(__dirname, "LumaArcade.nsi")}"`, __dirname, nsisEnv);

const setupExe = path.join(outputDir, "LumaArcadeSetup.exe");
console.log("=== 8. Signing the installer ===");
signFiles([setupExe]);

console.log("=== 9. Writing SHA256SUMS.txt ===");
const hash = createHash("sha256").update(readFileSync(setupExe)).digest("hex");
// Format understood by `sha256sum -c` and `certutil`-style checks: "<hash> *<file>".
writeFileSync(path.join(outputDir, "SHA256SUMS.txt"), `${hash} *LumaArcadeSetup.exe\n`, "utf-8");
console.log(`SHA-256 ${hash}`);

console.log(`\nDone: ${setupExe}`);
