import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const stagingDir = path.join(__dirname, "staging");
const outputDir = path.join(__dirname, "output");

const NODE_EXE = "C:\\Program Files\\nodejs\\node.exe";
const MAKENSIS = "C:\\Program Files (x86)\\NSIS\\makensis.exe";
// The customized moonlight-web-stream build (its own repo,
// moonlight-web-stream-luma): web-server.exe, streamer.exe, static\, server\.
const MOONLIGHT_DIR =
  process.env.MOONLIGHT_PACKAGE_DIR || path.join(repoRoot, "..", "moonlight-web-stream-bin", "package");

function run(cmd, cwd) {
  console.log(`> ${cmd}${cwd ? `  (cwd=${cwd})` : ""}`);
  execSync(cmd, { cwd, stdio: "inherit", shell: true });
}

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
if (!existsSync(path.join(MOONLIGHT_DIR, "web-server.exe"))) {
  throw new Error(`moonlight-web-stream not found at ${MOONLIGHT_DIR} — set MOONLIGHT_PACKAGE_DIR`);
}
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
  [repoRoot, ["profiles.ps1", "esde-game-started.ps1"]],
];
for (const [root, files] of hostFiles) {
  for (const file of files) cpSync(path.join(root, "host", file), path.join(hostStage, file));
}
if (!existsSync(path.join(__dirname, "scripts", "versions.json"))) {
  throw new Error("installer/scripts/versions.json is missing — run installer/scripts/update-versions.ps1");
}

console.log("=== 5. Copying portable node.exe ===");
if (!existsSync(NODE_EXE)) {
  throw new Error(`Expected Node.js at ${NODE_EXE} — adjust installer/build.mjs if it moved`);
}
cpSync(NODE_EXE, path.join(stagingDir, "node.exe"));

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

console.log("=== 7. Running makensis ===");
mkdirSync(outputDir, { recursive: true });
if (!existsSync(MAKENSIS)) {
  throw new Error(`makensis not found at ${MAKENSIS} — is NSIS installed?`);
}
run(`"${MAKENSIS}" "${path.join(__dirname, "LumaArcade.nsi")}"`, __dirname);

console.log(`\nDone: ${path.join(outputDir, "LumaArcadeSetup.exe")}`);
