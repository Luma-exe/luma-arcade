-- Per-person rules LumaArcade adds on top of moonlight-web-stream's users
-- and roles (which already cover bitrate, codecs, HDR and adding hosts).
-- user_id is the moonlight-web-stream user id (server/data.json users).
CREATE TABLE IF NOT EXISTS user_access (
  user_id INTEGER PRIMARY KEY,
  -- JSON array of Sunshine app names this person may start; NULL = every app
  apps TEXT,
  -- JSON array of settings sections they may open; NULL = every player section
  settings TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
