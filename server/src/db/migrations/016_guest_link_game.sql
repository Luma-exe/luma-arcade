-- A guest link that opens straight into a game: the game_plays row to start
-- again (web/games.ts launchableGame). NULL = they pick in ES-DE.
ALTER TABLE guest_links ADD COLUMN game_play_id INTEGER;
