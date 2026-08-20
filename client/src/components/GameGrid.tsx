import { useMemo, useState } from "react";
import type { GameRow } from "../lib/api.js";

export function GameGrid({
  games,
  onLaunch,
}: {
  games: GameRow[];
  onLaunch: (game: GameRow) => void;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return games;
    return games.filter((g) => g.title.toLowerCase().includes(q));
  }, [games, query]);

  return (
    <div className="game-grid-wrap">
      <input
        className="search"
        placeholder="Search…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="game-grid">
        {filtered.map((game) => (
          <button key={game.id} className="game-tile" onClick={() => onLaunch(game)}>
            <div className="game-art">
              {game.box_art_url ? (
                <img src={game.box_art_url} alt="" loading="lazy" />
              ) : (
                <div className="game-art-placeholder">{game.title[0]}</div>
              )}
            </div>
            <div className="game-title">{game.title}</div>
            {game.last_played_at && (
              <div className="game-last-played">Last played {formatDate(game.last_played_at)}</div>
            )}
          </button>
        ))}
        {filtered.length === 0 && <p className="muted">No games found.</p>}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso.replace(" ", "T") + "Z").toLocaleDateString();
  } catch {
    return iso;
  }
}
