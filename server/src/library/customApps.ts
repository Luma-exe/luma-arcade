import { getDb } from "../db/index.js";
import type { ScannedGame } from "./steamScanner.js";

export interface CustomAppRow {
  id: number;
  display_name: string;
  exe_path: string;
  icon_path: string | null;
}

export function listCustomApps(): CustomAppRow[] {
  return getDb().prepare("SELECT * FROM custom_apps ORDER BY display_name").all() as CustomAppRow[];
}

export function addCustomApp(row: { displayName: string; exePath: string; iconPath?: string }): void {
  getDb()
    .prepare(
      `INSERT INTO custom_apps (display_name, exe_path, icon_path)
       VALUES (@displayName, @exePath, @iconPath)`
    )
    .run({ iconPath: null, ...row });
}

export function removeCustomApp(id: number): void {
  getDb().prepare("DELETE FROM custom_apps WHERE id = ?").run(id);
}

export function scanCustomApps(): ScannedGame[] {
  return listCustomApps().map((app) => ({
    externalId: String(app.id),
    title: app.display_name,
    launchTarget: app.exe_path,
  }));
}
