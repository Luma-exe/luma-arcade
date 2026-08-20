import type { GameRow } from "../lib/api.js";
import { systemBackgroundUrl, fallbackTileBg } from "../lib/theme.js";

export interface ThemeColors {
  bg: string;
  surface: string;
  ink: string;
  inkMuted: string;
  pillBg: string;
  pillText: string;
  helpBg: string;
  cardShadow: string;
  star: string;
}

export function GameListView({
  theme,
  systemId,
  systemName,
  games,
  selectedIndex,
  onSelect,
  onLaunch,
  onBack,
  helpEntries,
}: {
  theme: ThemeColors;
  systemId: string;
  systemName: string;
  games: GameRow[];
  selectedIndex: number;
  onSelect: (i: number) => void;
  onLaunch: (game: GameRow) => void;
  onBack: () => void;
  helpEntries: { icon: string; label: string }[];
}) {
  const game = games[selectedIndex];
  const backdropUrl = systemBackgroundUrl(systemId);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: theme.bg,
        zIndex: 20,
        padding: "5cqh 4cqw 4cqh",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1.35fr",
          gap: "3cqw",
          height: "76cqh",
        }}
      >
        <div
          style={{
            overflow: "hidden",
            borderRadius: "1cqh",
            background: theme.surface,
            boxShadow: `0 1cqh 3cqh ${theme.cardShadow}`,
            padding: "1.5cqh 0",
            overflowY: "auto",
          }}
        >
          {games.map((g, i) => {
            const isSel = i === selectedIndex;
            return (
              <div
                key={g.id}
                onClick={() => onSelect(i)}
                onDoubleClick={() => onLaunch(g)}
                style={{
                  cursor: "pointer",
                  padding: "1.6cqh 1.6cqw",
                  fontWeight: 800,
                  fontSize: "1.05cqw",
                  letterSpacing: "0.01em",
                  color: isSel ? theme.pillText : theme.ink,
                  background: isSel ? theme.pillBg : "transparent",
                  transition: "background .2s ease, color .2s ease",
                }}
              >
                {g.title}
              </div>
            );
          })}
          {games.length === 0 && (
            <div style={{ padding: "1.6cqh 1.6cqw", color: theme.inkMuted, fontSize: "0.95cqw" }}>
              No games found here yet.
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "2.4cqh" }}>
          <div
            onClick={() => game && onLaunch(game)}
            style={{
              position: "relative",
              flex: 1,
              borderRadius: "1cqh",
              overflow: "hidden",
              background: backdropUrl ? undefined : fallbackTileBg(systemId),
              boxShadow: `0 1cqh 3cqh ${theme.cardShadow}`,
              cursor: game ? "pointer" : "default",
            }}
          >
            {backdropUrl && (
              <img
                src={backdropUrl}
                alt=""
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            )}
            {game?.box_art_url && (
              <div
                style={{
                  position: "absolute",
                  left: "1.4cqw",
                  bottom: "1.4cqh",
                  width: "15cqw",
                  aspectRatio: "3/4",
                  borderRadius: "0.4cqh",
                  overflow: "hidden",
                  boxShadow: "0 0.8cqh 2cqh rgba(0,0,0,0.35)",
                  border: `2px solid ${theme.surface}`,
                }}
              >
                <img
                  src={game.box_art_url}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              </div>
            )}
          </div>

          {game && (game.rating_5 || game.genre || game.release_year || game.developer) && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3,1fr)",
                gap: "0.7cqw",
              }}
            >
              {game.rating_5 && (
                <MetaBox theme={theme} label="Rating">
                  <span style={{ letterSpacing: "0.1em" }}>
                    {"★".repeat(game.rating_5) + "☆".repeat(5 - game.rating_5)}
                  </span>
                </MetaBox>
              )}
              {game.genre && <MetaBox theme={theme} label="Genre">{game.genre}</MetaBox>}
              {game.release_year && (
                <MetaBox theme={theme} label="Released">{game.release_year}</MetaBox>
              )}
              {game.developer && (
                <MetaBox theme={theme} label="Developer" span={!game.rating_5 || !game.genre || !game.release_year ? 1 : 2}>
                  {game.developer}
                </MetaBox>
              )}
            </div>
          )}

          {game?.description && (
            <div
              style={{
                color: theme.ink,
                fontSize: "1cqw",
                lineHeight: 1.5,
                maxWidth: "38cqw",
                overflow: "auto",
              }}
            >
              {game.description}
            </div>
          )}
        </div>
      </div>

      <div
        onClick={onBack}
        style={{
          position: "absolute",
          left: "4cqw",
          bottom: "3cqh",
          display: "flex",
          alignItems: "center",
          gap: "0.6cqw",
          cursor: "pointer",
        }}
      >
        <div style={{ fontFamily: "var(--font-display)", fontSize: "1.6cqw", color: theme.ink }}>
          {systemName}
        </div>
      </div>

      <div style={{ position: "absolute", right: "4cqw", bottom: "3cqh", display: "flex", gap: "1.1cqw" }}>
        {helpEntries.map((h, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5cqw",
              color: theme.inkMuted,
              fontWeight: 700,
              fontSize: "0.85cqw",
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minWidth: "1.9cqw",
                height: "1.9cqw",
                padding: "0 0.3cqw",
                borderRadius: "0.5cqw",
                background: theme.helpBg,
                color: theme.ink,
                fontSize: "0.8cqw",
              }}
            >
              {h.icon}
            </span>
            {h.label}
          </div>
        ))}
      </div>
    </div>
  );
}

function MetaBox({
  theme,
  label,
  span,
  children,
}: {
  theme: ThemeColors;
  label: string;
  span?: number;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: `1px solid ${theme.helpBg}`,
        borderRadius: "0.5cqh",
        padding: "0.8cqh 1cqw",
        gridColumn: span ? `span ${span}` : undefined,
      }}
    >
      <div
        style={{
          fontSize: "0.65cqw",
          fontWeight: 700,
          color: theme.inkMuted,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          marginBottom: "0.3cqh",
        }}
      >
        {label}
      </div>
      <div style={{ color: theme.ink, fontWeight: 700, fontSize: "0.95cqw" }}>{children}</div>
    </div>
  );
}
