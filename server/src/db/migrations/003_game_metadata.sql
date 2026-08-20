ALTER TABLE games ADD COLUMN genre TEXT;
ALTER TABLE games ADD COLUMN developer TEXT;
ALTER TABLE games ADD COLUMN release_year INTEGER;
ALTER TABLE games ADD COLUMN description TEXT;
ALTER TABLE games ADD COLUMN rating_5 INTEGER;
-- Marks that an IGDB lookup was attempted (found or not), so unmatched
-- titles (common for ROM dumps) aren't re-queried on every library scan.
ALTER TABLE games ADD COLUMN metadata_checked_at TEXT;
