// Copies LumaArcade's database while the server is running (SQLite's online
// backup: a consistent snapshot even mid-write, which a plain file copy of a
// WAL database isn't). Used by the nightly "Game Save Backup" task
// (E:\GameSaveBackups\backup-saves.ps1):
//   node server/scripts/backup-db.mjs <destination.db>
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dest = process.argv[2];
if (!dest) {
  console.error("usage: node backup-db.mjs <destination.db>");
  process.exit(2);
}
const source = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "luma-arcade.db");
const db = new Database(source, { readonly: true, fileMustExist: true });
try {
  await db.backup(dest);
  console.log(`backed up ${source} -> ${dest}`);
} finally {
  db.close();
}
