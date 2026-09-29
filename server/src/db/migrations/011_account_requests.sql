-- "Request an account" on the welcome page (web/routes/welcome.ts): one per
-- visitor address, sent to the admin on Discord. Times are epoch ms.
CREATE TABLE IF NOT EXISTS account_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- the visitor's address (Cloudflare's CF-Connecting-IP through the tunnel)
  ip TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  -- how to reach them (their Discord), if they said
  contact TEXT,
  message TEXT,
  created_at INTEGER NOT NULL,
  -- the Discord post went out
  delivered INTEGER NOT NULL DEFAULT 0
);
