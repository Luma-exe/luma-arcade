-- A guest link turned into a real account: its saves, stats, snapshots and
-- play history went to this moonlight-web-stream user.
ALTER TABLE guest_links ADD COLUMN converted_to_user_id INTEGER;
ALTER TABLE guest_links ADD COLUMN converted_to_name TEXT;
ALTER TABLE guest_links ADD COLUMN converted_at INTEGER;
