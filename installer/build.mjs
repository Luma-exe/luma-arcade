import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const stagingDir = path.join(__dirname, "staging");
const outputDir = path.join(__dirname, "output");

const NODE_EXE = "C:\\Program Files\\nodejs\\node.exe";
const MAKENSIS = "C:\\Program Files (x86)\\NSIS\\makensis.exe";

function run(cmd, cwd) {
  console.log(`> ${cmd}${cwd ? `  (cwd=${cwd})` : ""}`);
  execSync(cmd, { cwd, stdio: "inherit", shell: true });
}

console.log("=== 1. Building client + server ===");
run("npm run build", repoRoot);

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
cpSync(path.join(repoRoot, "client", "dist"), path.join(stagingDir, "client", "dist"), {
  recursive: true,
});
cpSync(path.join(__dirname, "scripts"), path.join(stagingDir, "scripts"), {
  recursive: true,
});

console.log("=== 3. Installing production dependencies into staged copy ===");
run("npm install --omit=dev --no-audit --no-fund", path.join(stagingDir, "server"));

if (
  !existsSync(
    path.join(stagingDir, "server", "node_modules", "better-sqlite3", "build", "Release")
  )
) {
  throw new Error(
    "better-sqlite3 native binary missing from staged node_modules — packaging would produce a broken installer"
  );
}

console.log("=== 4. Copying portable node.exe ===");
if (!existsSync(NODE_EXE)) {
  throw new Error(`Expected Node.js at ${NODE_EXE} — adjust installer/build.mjs if it moved`);
}
cpSync(NODE_EXE, path.join(stagingDir, "node.exe"));

console.log("=== 5. Writing launcher script ===");
writeFileSync(
  path.join(stagingDir, "LumaArcade.vbs"),
  [
    'Set shell = CreateObject("WScript.Shell")',
    'shell.CurrentDirectory = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\\") - 1)',
    'shell.Run """node.exe"" server\\dist\\main.js", 0, False',
  ].join("\r\n"),
  "utf-8"
);

console.log("=== 6. Running makensis ===");
mkdirSync(outputDir, { recursive: true });
if (!existsSync(MAKENSIS)) {
  throw new Error(`makensis not found at ${MAKENSIS} — is NSIS installed?`);
}
run(`"${MAKENSIS}" "${path.join(__dirname, "LumaArcade.nsi")}"`, __dirname);

console.log(`\nDone: ${path.join(outputDir, "LumaArcadeSetup.exe")}`);
