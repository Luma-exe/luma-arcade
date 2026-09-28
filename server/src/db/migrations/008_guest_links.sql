-- Temporary links for people without an account (guestLinks.ts). Each link
-- has its own throwaway moonlight-web-stream user, signed in by LumaArcade
-- when the link is opened. Times are epoch ms.
CREATE TABLE IF NOT EXISTS guest_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  -- who it's for, as the admin typed it
  name TEXT NOT NULL,
  -- 'play': their own turn on the PC; 'coop': join the creator's game as player 2
  mode TEXT NOT NULL CHECK (mode IN ('play', 'coop')),
  -- the moonlight-web-stream account behind it
  user_id INTEGER NOT NULL,
  user_name TEXT NOT NULL,
  password TEXT NOT NULL,
  -- play time allowed in total; NULL = as much as they like until expires_at
  minutes INTEGER,
  expires_at INTEGER NOT NULL,
  created_by_id INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- turned off by an admin (its account is deleted then)
  revoked_at INTEGER,
  -- its moonlight-web-stream account was deleted (revoked or long expired)
  account_deleted_at INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  first_used_at INTEGER,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS guest_links_user ON guest_links (user_id);
