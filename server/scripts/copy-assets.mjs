import { cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

cpSync(
  path.join(root, "src", "db", "migrations"),
  path.join(root, "dist", "db", "migrations"),
  { recursive: true }
);
