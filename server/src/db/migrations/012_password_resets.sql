-- "Forgot your password?" on the welcome page (web/routes/welcome.ts): sent
-- to the admin on Discord, once a day per visitor address. Times are epoch ms.
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  -- the account name they sign in with
  name TEXT NOT NULL,
  contact TEXT,
  message TEXT,
  created_at INTEGER NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS password_resets_ip ON password_resets (ip, created_at);
