-- Which games were played inside an app (ES-DE), from ES-DE's game-start
-- event script (C:\ProgramData\LumaArcade\esde-game-events.ps1 writes
-- home\games.jsonl; web/games.ts reads it). Times are epoch ms.
CREATE TABLE IF NOT EXISTS game_plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- the event script's id for this launch
  launch_id TEXT NOT NULL UNIQUE,
  -- who had the PC (moonlight-web-stream user); 0 when nobody did
  user_id INTEGER NOT NULL,
  user_name TEXT NOT NULL,
  app TEXT NOT NULL,
  title TEXT NOT NULL,
  -- ES-DE system name ("xbox360", "steam", "windows"...)
  system TEXT,
  -- what ES-DE launched: the ROM or shortcut file
  rom TEXT,
  -- the game's own process once it was in front: to close it, and to relaunch it
  pid INTEGER,
  exe TEXT,
  command_line TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS game_plays_started ON game_plays (started_at);
CREATE INDEX IF NOT EXISTS game_plays_user ON game_plays (user_id, started_at);
