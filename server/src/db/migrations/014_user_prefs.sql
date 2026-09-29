-- A player's own choices (settings screen, "My play"): whether the welcome
-- page may say what they're playing. Off unless they turn it on.
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id INTEGER PRIMARY KEY,
  share_playing INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
