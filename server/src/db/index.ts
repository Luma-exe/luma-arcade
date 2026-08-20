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

  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))"
  );
  const applied = new Set(
    (db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map(
      (r) => r.name
    )
  );

  const migrationsDir = path.join(__dirname, "migrations");
  const migrationFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of migrationFiles) {
    if (applied.has(file)) continue;
    db.exec(readFileSync(path.join(migrationsDir, file), "utf-8"));
    db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(file);
  }

  return db;
}
