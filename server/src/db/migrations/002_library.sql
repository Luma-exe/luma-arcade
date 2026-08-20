CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('steam', 'epic', 'emulation', 'custom')),
  external_id TEXT,
  title TEXT NOT NULL,
  launch_target TEXT NOT NULL,
  console TEXT,
  box_art_url TEXT,
  last_played_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, external_id)
);

CREATE TABLE IF NOT EXISTS rom_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  console TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  emulator_exe_path TEXT NOT NULL,
  launch_args_template TEXT NOT NULL DEFAULT '{rom}'
);

CREATE TABLE IF NOT EXISTS custom_apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  exe_path TEXT NOT NULL,
  icon_path TEXT
);
