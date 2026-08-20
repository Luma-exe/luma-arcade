import { getDb } from "../db/index.js";
import type { GameMetadata } from "./igdb.js";

export interface GameRow {
  id: number;
  source: "steam" | "epic" | "emulation" | "custom";
  external_id: string | null;
  title: string;
  launch_target: string;
  console: string | null;
  box_art_url: string | null;
  last_played_at: string | null;
  genre: string | null;
  developer: string | null;
  release_year: number | null;
  description: string | null;
  rating_5: number | null;
  metadata_checked_at: string | null;
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

/** Every scan retries games still missing box art (not just ones never
 * checked before) — deliberately not gated on metadata_checked_at. Gating on
 * "checked before" meant a game that failed to match *before* IGDB
 * credentials were ever entered would never be retried again, since nothing
 * about a credentials save necessarily looks like a "change" (re-entering
 * the same value, or the value predating a code fix that starts honoring
 * it). Retrying art-less games on every scan is simple, predictable, and
 * self-limiting — once a game gets art it's never queried again. */
export function gamesMissingMetadata(): GameRow[] {
  return getDb().prepare("SELECT * FROM games WHERE box_art_url IS NULL").all() as GameRow[];
}

export function setGameMetadata(id: number, metadata: GameMetadata): void {
  getDb()
    .prepare(
      `UPDATE games SET
         box_art_url = @boxArtUrl,
         genre = @genre,
         developer = @developer,
         release_year = @releaseYear,
         description = @description,
         rating_5 = @rating5,
         metadata_checked_at = datetime('now')
       WHERE id = @id`
    )
    .run({
      id,
      boxArtUrl: metadata.boxArtUrl ?? null,
      genre: metadata.genre ?? null,
      developer: metadata.developer ?? null,
      releaseYear: metadata.releaseYear ?? null,
      description: metadata.description ?? null,
      rating5: metadata.rating5 ?? null,
    });
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
