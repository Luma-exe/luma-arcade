import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized — call initDb() first");
  }
  return db;
}

export function initDb(dbPath: string): Database.Database {
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  const migrationsDir = path.join(__dirname, "migrations");
  const migrationFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of migrationFiles) {
    db.exec(readFileSync(path.join(migrationsDir, file), "utf-8"));
  }

  return db;
}
