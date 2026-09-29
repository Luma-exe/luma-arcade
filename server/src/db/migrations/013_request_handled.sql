-- Account and password requests an admin has dealt with (the admin screen's
-- Requests tab, web/routes/welcome.ts).
ALTER TABLE account_requests ADD COLUMN handled_at INTEGER;
ALTER TABLE account_requests ADD COLUMN handled_by TEXT;
ALTER TABLE password_resets ADD COLUMN handled_at INTEGER;
ALTER TABLE password_resets ADD COLUMN handled_by TEXT;
