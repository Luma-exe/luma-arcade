-- Two settings that used to be baked in as the author's own choices.
--
-- Settings are stored as rows only once something is saved (config/settings.ts
-- falls back to a default in code), so a missing row means "the default".
-- Changing a default in code therefore changes every install that never saved
-- the setting; these inserts pin the old behaviour for installs that already
-- exist, and leave a fresh install on the new defaults.
--
-- "Already existed" comes from db/index.ts: when the database had migrations
-- recorded before this run, it makes a temporary table _existing_install on
-- this connection. A brand new database never gets one, however many
-- migrations run in the same start.

-- adminDiscordId (who the account request post pings): the author's own
-- arcade has a Discord webhook set up and used to ping this id, so keep it
-- for an install that already has a webhook. A fresh install gets "" (no ping).
INSERT OR IGNORE INTO settings (key, value)
SELECT 'adminDiscordId', '"851332798231871508"'
WHERE EXISTS (SELECT 1 FROM sqlite_temp_master WHERE name = '_existing_install')
  AND EXISTS (SELECT 1 FROM settings WHERE key = 'discordWebhookUrl' AND value NOT IN ('""', 'null', ''));

-- privateServer now defaults to true. Existing installs keep what they had
-- (off) unless they saved a value.
INSERT OR IGNORE INTO settings (key, value)
SELECT 'privateServer', 'false'
WHERE EXISTS (SELECT 1 FROM sqlite_temp_master WHERE name = '_existing_install');
