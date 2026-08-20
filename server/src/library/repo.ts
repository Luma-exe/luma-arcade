import { getDb } from "../db/index.js";

export interface GameRow {
  id: number;
  source: "steam" | "epic" | "emulation" | "custom";
  external_id: string | null;
  title: string;
  launch_target: string;
  console: string | null;
  box_art_url: string | null;
  last_played_at: string | null;
}

export function upsertGame(game: {
  source: GameRow["source"];
  externalId: string;
  title: string;
  launchTarget: string;
  console?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO games (source, external_id, title, launch_target, console)
       VALUES (@source, @externalId, @title, @launchTarget, @console)
       ON CONFLICT(source, external_id) DO UPDATE SET
         title = excluded.title,
         launch_target = excluded.launch_target,
         console = excluded.console`
    )
    .run({ console: null, ...game });
}

export function listGames(source?: GameRow["source"]): GameRow[] {
  if (source) {
    return getDb()
      .prepare("SELECT * FROM games WHERE source = ? ORDER BY title")
      .all(source) as GameRow[];
  }
  return getDb().prepare("SELECT * FROM games ORDER BY title").all() as GameRow[];
}

export function getGame(id: number): GameRow | undefined {
  return getDb().prepare("SELECT * FROM games WHERE id = ?").get(id) as GameRow | undefined;
}

export function gamesMissingBoxArt(): GameRow[] {
  return getDb()
    .prepare("SELECT * FROM games WHERE box_art_url IS NULL")
    .all() as GameRow[];
}

export function setBoxArt(id: number, boxArtUrl: string): void {
  getDb().prepare("UPDATE games SET box_art_url = ? WHERE id = ?").run(boxArtUrl, id);
}

export function markPlayed(id: number): void {
  getDb()
    .prepare("UPDATE games SET last_played_at = datetime('now') WHERE id = ?")
    .run(id);
}

export function listDistinctConsoles(): string[] {
  const rows = getDb()
    .prepare("SELECT DISTINCT console FROM games WHERE console IS NOT NULL")
    .all() as { console: string }[];
  return rows.map((r) => r.console);
}
