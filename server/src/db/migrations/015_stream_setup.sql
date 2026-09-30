-- The one-time stream setup a player does before their first stream
-- (moonlight-web-stream's setup.html): steady or automatic quality, and the
-- settings its 30-second speed test picked. NULL quality_setup_at = not done
-- yet. quality_settings is JSON, so another browser can start from it too.
ALTER TABLE user_prefs ADD COLUMN quality_mode TEXT;
ALTER TABLE user_prefs ADD COLUMN quality_settings TEXT;
ALTER TABLE user_prefs ADD COLUMN quality_setup_at INTEGER;
