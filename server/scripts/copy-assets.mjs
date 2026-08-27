import { cpSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

cpSync(
  path.join(root, "src", "db", "migrations"),
  path.join(root, "dist", "db", "migrations"),
  { recursive: true }
);

// Stamps the build with the exact commit it was built from, so the running
// app can tell it's out of date against origin/main (see remote/updateCheck.ts)
// without needing a .git checkout at runtime — the packaged installer only
// ships dist/, not source control metadata.
let commit = "unknown";
try {
  commit = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf-8" }).trim();
} catch {
  // Not in a git checkout (e.g. a re-packaged build without .git) — leave "unknown".
}
writeFileSync(
  path.join(root, "dist", "version.json"),
  JSON.stringify({ commit, builtAt: new Date().toISOString() }, null, 2)
);
