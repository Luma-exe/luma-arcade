// Builds the Linux bundle (Linux support is an early beta):
//   installer/output/LumaArcade-linux.tar.gz
// It holds the built server, Luma Arcade's moonlight-web-stream web files
// and config, first-run.mjs and the install scripts. install.sh downloads
// Node and moonlight-web-stream's Linux programs itself (pinned versions,
// checked against their SHA-256), and installs the server's dependencies on
// the Linux PC (better-sqlite3 is a native module).
//
//   node installer/linux/build.mjs
import { execSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..", "..");
const outputDir = path.join(__dirname, "..", "output");
const stage = path.join(__dirname, "..", "staging-linux");
const root = path.join(stage, "luma-arcade");
// The same customized web files the Windows installer ships (installer/build.mjs).
const MOONLIGHT_DIR =
  process.env.MOONLIGHT_PACKAGE_DIR || path.join(repoRoot, "..", "moonlight-web-stream-bin", "package");

function run(cmd, cwd) {
  console.log(`> ${cmd}${cwd ? `  (cwd=${cwd})` : ""}`);
  execSync(cmd, { cwd, stdio: "inherit", shell: true });
}

const { version } = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8"));

console.log("=== 1. Building server ===");
run("npm run build -w server", repoRoot);

console.log("=== 2. Staging ===");
rmSync(stage, { recursive: true, force: true });
mkdirSync(path.join(root, "server"), { recursive: true });
cpSync(path.join(repoRoot, "server", "dist"), path.join(root, "server", "dist"), { recursive: true });
cpSync(path.join(repoRoot, "server", "assets"), path.join(root, "server", "assets"), { recursive: true });
cpSync(path.join(repoRoot, "server", "package.json"), path.join(root, "server", "package.json"));

console.log("=== 3. moonlight-web-stream web files and config ===");
if (!existsSync(path.join(MOONLIGHT_DIR, "static"))) {
  throw new Error(`moonlight-web-stream not found at ${MOONLIGHT_DIR} - set MOONLIGHT_PACKAGE_DIR`);
}
const ml = path.join(root, "moonlight-web-stream");
mkdirSync(path.join(ml, "server"), { recursive: true });
cpSync(path.join(MOONLIGHT_DIR, "static"), path.join(ml, "static"), {
  recursive: true,
  filter: (src) => !/[\\/]_backup|\.bak-/.test(src),
});
const config = JSON.parse(readFileSync(path.join(MOONLIGHT_DIR, "server", "config.json"), "utf-8"));
config.web_server.session_cookie_secure = false;
config.moonlight.pair_device_name = "LumaArcade";
config.web_server.first_login_create_admin = true;
config.web_server.first_login_assign_global_hosts = true;
// The TURN helper is a Windows batch file; on Linux, STUN only for now.
config.webrtc.ice_server_script = null;
config.data_storage.path = "server/data.json";
writeFileSync(path.join(ml, "server", "config.default.json"), JSON.stringify(config, null, 4));

console.log("=== 4. Scripts ===");
mkdirSync(path.join(root, "setup"), { recursive: true });
cpSync(path.join(repoRoot, "installer", "scripts", "first-run.mjs"), path.join(root, "setup", "first-run.mjs"));
for (const file of ["install.sh", "uninstall.sh"]) {
  cpSync(path.join(__dirname, file), path.join(root, file));
  chmodSync(path.join(root, file), 0o755);
}
writeFileSync(path.join(root, "VERSION"), `${version}\n`);

console.log("=== 5. Packing ===");
mkdirSync(outputDir, { recursive: true });
const out = path.join(outputDir, "LumaArcade-linux.tar.gz");
rmSync(out, { force: true });
// (Built on Windows, files lose their "executable" bit: install.sh sets it again.)
// Relative paths: GNU tar would read "C:" as a remote host.
run("tar -czf output/LumaArcade-linux.tar.gz -C staging-linux luma-arcade", path.join(__dirname, ".."));
console.log(`\nDone: ${out} (Luma Arcade ${version} for Linux - early beta)`);
