-- LumaArcade's old portal password and its sessions: moonlight-web-stream's
-- sign-in replaced them.
DROP TABLE IF EXISTS auth;
DROP TABLE IF EXISTS sessions;

-- Who played what, and for how long: one row per stretch of streaming (a
-- quick reconnect to the same app continues the row). Times are epoch ms.
CREATE TABLE IF NOT EXISTS play_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- moonlight-web-stream user id and the name they had then
  user_id INTEGER NOT NULL,
  user_name TEXT NOT NULL,
  app TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  -- last time the stream was known to be open; the end if the server stops
  last_seen_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS play_sessions_started ON play_sessions (started_at);

-- The cookie secret signed the old portal session cookie.
DELETE FROM settings WHERE key = 'cookieSecret';
