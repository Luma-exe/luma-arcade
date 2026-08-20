import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { getDb } from "../db/index.js";
import type { ScannedGame } from "./steamScanner.js";

export interface RomFolderRow {
  id: number;
  console: string;
  folder_path: string;
  emulator_exe_path: string;
  launch_args_template: string;
}

export function listRomFolders(): RomFolderRow[] {
  return getDb().prepare("SELECT * FROM rom_folders ORDER BY console").all() as RomFolderRow[];
}

export function addRomFolder(row: {
  console: string;
  folderPath: string;
  emulatorExePath: string;
  launchArgsTemplate: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO rom_folders (console, folder_path, emulator_exe_path, launch_args_template)
       VALUES (@console, @folderPath, @emulatorExePath, @launchArgsTemplate)`
    )
    .run(row);
}

export function removeRomFolder(id: number): void {
  getDb().prepare("DELETE FROM rom_folders WHERE id = ?").run(id);
}

// Extensions with no reliable single-file identity (multi-track CD images,
// etc.) are intentionally left out for Phase 3 — folder scanning covers the
// common single-file ROM formats.
const ROM_EXTENSIONS = new Set([
  ".z64", ".n64", ".v64",
  ".nes", ".sfc", ".smc",
  ".gba", ".gb", ".gbc",
  ".nds", ".3ds",
  ".iso", ".bin", ".cue", ".chd",
  ".gen", ".md",
]);

export function scanRomFolders(): (ScannedGame & { console: string })[] {
  const games: (ScannedGame & { console: string })[] = [];

  for (const folder of listRomFolders()) {
    if (!existsSync(folder.folder_path)) continue;

    for (const file of readdirSync(folder.folder_path)) {
      const fullPath = path.join(folder.folder_path, file);
      if (!statSync(fullPath).isFile()) continue;

      const ext = path.extname(file).toLowerCase();
      if (!ROM_EXTENSIONS.has(ext)) continue;

      const title = path.basename(file, ext);
      games.push({
        externalId: fullPath,
        title,
        launchTarget: fullPath,
        console: folder.console,
      });
    }
  }

  return games;
}
