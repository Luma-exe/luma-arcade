import { useEffect, useMemo, useState } from "react";
import { api, type AppSettings, type GameRow } from "../lib/api.js";
import { getSystemDisplayName } from "../lib/systemNames.js";
import {
  fallbackTileBg,
  systemBackgroundUrl,
  systemCarouselIconUrl,
  systemLogoUrl,
} from "../lib/theme.js";
import { sounds } from "../lib/sounds.js";
import { GameListView } from "../components/GameListView.js";

const ACCENT_HUE = 45;
const THEME = {
  bg: "oklch(20% 0.012 250)",
  surface: "oklch(26% 0.012 250)",
  ink: "oklch(96% 0.006 250)",
  inkMuted: "oklch(72% 0.01 250)",
  pillBg: "oklch(12% 0.01 250)",
  pillText: "oklch(97% 0 0)",
  carouselTextBg: "oklch(12% 0.01 250)",
  carouselText: "oklch(97% 0 0)",
  helpBg: "oklch(32% 0.012 250)",
  cardShadow: "rgba(0,0,0,0.45)",
  accent: `oklch(72% 0.15 ${ACCENT_HUE})`,
  accentGlow: `oklch(72% 0.15 ${ACCENT_HUE} / 0.45)`,
  star: `oklch(78% 0.15 ${ACCENT_HUE})`,
};

interface SystemTile {
  id: string;
  name: string;
  kind: "desktop" | "source" | "console";
  source?: GameRow["source"];
  games: GameRow[];
}

const HOME_HELP = [
  { icon: "←→", label: "Navigate" },
  { icon: "↵", label: "Select" },
  { icon: "Esc", label: "Menu" },
];
const LIST_HELP = [
  { icon: "↑↓", label: "Navigate" },
  { icon: "↵", label: "Play" },
  { icon: "Esc", label: "Back" },
];

export function Home({
  onLaunchFullDesktop,
  onLaunchGame,
  onOpenSettings,
}: {
  onLaunchFullDesktop: () => void;
  onLaunchGame: (game: GameRow, pid?: number) => void;
  onOpenSettings: () => void;
}) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [games, setGames] = useState<GameRow[]>([]);
  const [consoles, setConsoles] = useState<string[]>([]);
  const [view, setView] = useState<"home" | "game-list">("home");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedGameIndex, setSelectedGameIndex] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [activeStream, setActiveStream] = useState<{
    mode: "desktop" | "game";
    gameId?: number;
    pid?: number;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function loadAll() {
    try {
      const [s, g, romFolders, status] = await Promise.all([
        api.getSettings(),
        api.getGames(),
        api.getRomFolders(),
        api.getStreamStatus(),
      ]);
      setSettings(s);
      setGames(g);
      // Consoles come from configured ROM folders, not from games already
      // scanned — a freshly-added console with no ROMs yet should still show
      // up in the carousel with a 0 count, not disappear.
      setConsoles([...new Set(romFolders.map((f) => f.console))]);
      if (status.running) setActiveStream(status);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  const systems: SystemTile[] = useMemo(() => {
    if (!settings) return [];
    const list: SystemTile[] = [];
    if (settings.fullDesktopEnabled) {
      list.push({ id: "desktop", name: "Full Desktop", kind: "desktop", games: [] });
    }
    if (settings.steamEnabled) {
      list.push({
        id: "steam",
        name: "Steam",
        kind: "source",
        source: "steam",
        games: games.filter((g) => g.source === "steam"),
      });
    }
    if (settings.epicEnabled) {
      list.push({
        id: "epic",
        name: "Epic Games",
        kind: "source",
        source: "epic",
        games: games.filter((g) => g.source === "epic"),
      });
    }
    if (settings.customAppsEnabled) {
      list.push({
        id: "custom-collections",
        name: "Custom Apps",
        kind: "source",
        source: "custom",
        games: games.filter((g) => g.source === "custom"),
      });
    }
    if (settings.emulationEnabled) {
      for (const consoleId of consoles) {
        list.push({
          id: consoleId,
          name: getSystemDisplayName(consoleId),
          kind: "console",
          games: games.filter((g) => g.source === "emulation" && g.console === consoleId),
        });
      }
    }
    return list;
  }, [settings, games, consoles]);

  const clampedIndex = Math.min(selectedIndex, Math.max(0, systems.length - 1));
  const selected = systems[clampedIndex];

  function moveCarousel(delta: number) {
    setSelectedIndex((i) => {
      const next = Math.min(Math.max(i + delta, 0), systems.length - 1);
      if (next !== i) sounds.scroll();
      return next;
    });
  }

  function moveGameList(delta: number) {
    if (!selected) return;
    setSelectedGameIndex((i) => {
      const next = Math.min(Math.max(i + delta, 0), selected.games.length - 1);
      if (next !== i) sounds.scroll();
      return next;
    });
  }

  function openSystem(tile: SystemTile) {
    if (tile.kind === "desktop") {
      sounds.launch();
      onLaunchFullDesktop();
      return;
    }
    sounds.select();
    setSelectedGameIndex(0);
    setView("game-list");
  }

  function backToHome() {
    sounds.back();
    setView("home");
  }

  async function launchGame(game: GameRow) {
    sounds.launch();
    const result = await api.launchGame(game.id);
    onLaunchGame(game, result.pid);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (view === "home") {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          moveCarousel(1);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          moveCarousel(-1);
        } else if (e.key === "Enter" && selected) {
          openSystem(selected);
        }
      } else {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          moveGameList(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          moveGameList(-1);
        } else if (e.key === "Enter" && selected?.games[selectedGameIndex]) {
          launchGame(selected.games[selectedGameIndex]);
        } else if (e.key === "Escape" || e.key === "Backspace") {
          backToHome();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selected, selectedGameIndex, systems.length]);

  async function handleScan() {
    setScanning(true);
    try {
      await api.scanLibrary();
      await loadAll();
    } finally {
      setScanning(false);
    }
  }

  function handleResume() {
    if (!activeStream) return;
    if (activeStream.mode === "game" && activeStream.gameId) {
      const game = games.find((g) => g.id === activeStream.gameId);
      if (game) {
        onLaunchGame(game, activeStream.pid);
        return;
      }
    }
    onLaunchFullDesktop();
  }

  if (loadError) {
    return (
      <div className="center">
        <div className="auth-card">
          <p className="error">Couldn't reach LumaArcade: {loadError}</p>
          <button onClick={() => { setLoadError(null); loadAll(); }}>Retry</button>
        </div>
      </div>
    );
  }

  if (!settings) return <div className="center">Loading…</div>;

  if (systems.length === 0) {
    return (
      <div className="center">
        <div className="auth-card">
          <p>No sources are enabled yet.</p>
          <button onClick={onOpenSettings}>Open Settings</button>
        </div>
      </div>
    );
  }

  const tileW = 13;
  const gap = 0.3;
  const pitch = tileW + gap;
  const targetCenter = 27;
  const trackOffset = targetCenter - (clampedIndex * pitch + tileW / 2);

  const heroBackground = systemBackgroundUrl(selected.id);
  const heroFallback = fallbackTileBg(selected.id);

  return (
    <div
      style={{
        position: "relative",
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        background: "#000",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          containerType: "size" as any,
          overflow: "hidden",
          background: THEME.bg,
          fontFamily: "var(--font-body)",
          userSelect: "none",
        }}
      >
        {/* Hero backdrop */}
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            height: "74cqh",
            overflow: "hidden",
            background: heroBackground ? undefined : heroFallback,
            transition: "background .45s ease",
          }}
        >
          {heroBackground && (
            <img
              src={heroBackground}
              alt=""
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          )}
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: "46%",
              background: `linear-gradient(to bottom, transparent, ${THEME.bg})`,
              pointerEvents: "none",
            }}
          />
        </div>

        {/* Branding pill + system logo */}
        <div
          style={{
            position: "absolute",
            left: "4cqw",
            top: "36cqh",
            display: "flex",
            flexDirection: "column",
            gap: "1.2cqh",
            zIndex: 5,
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignSelf: "flex-start",
              alignItems: "center",
              gap: "0.6cqw",
              background: THEME.pillBg,
              color: THEME.pillText,
              padding: "0.7cqh 1cqw",
              borderRadius: 999,
              fontFamily: "var(--font-accent)",
              fontWeight: 700,
              fontSize: "0.85cqw",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            <span
              style={{
                width: "0.45cqw",
                height: "0.45cqw",
                borderRadius: "50%",
                background: THEME.accent,
              }}
            />
            Luma Arcade
          </div>
          <img
            src={systemLogoUrl(selected.id)}
            alt={selected.name}
            style={{ maxWidth: "32cqw", maxHeight: "9cqh", filter: "drop-shadow(0 0.3cqh 0.6cqh rgba(0,0,0,0.4))" }}
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        </div>

        {activeStream && (
          <div
            style={{
              position: "absolute",
              right: "4cqw",
              top: "3cqh",
              zIndex: 6,
              display: "flex",
              alignItems: "center",
              gap: "0.6cqw",
              background: THEME.pillBg,
              color: THEME.pillText,
              padding: "0.7cqh 1cqw",
              borderRadius: 999,
              fontWeight: 700,
              fontSize: "0.8cqw",
              cursor: "pointer",
            }}
            onClick={handleResume}
          >
            Resume Stream
          </div>
        )}

        <button
          onClick={onOpenSettings}
          title="Settings"
          style={{
            position: "absolute",
            left: "4cqw",
            top: "3cqh",
            zIndex: 6,
            width: "2.2cqw",
            height: "2.2cqw",
            minWidth: 28,
            minHeight: 28,
            borderRadius: "50%",
            border: "none",
            background: THEME.pillBg,
            color: THEME.pillText,
            cursor: "pointer",
            fontSize: "1cqw",
          }}
        >
          ⚙
        </button>

        {/* Carousel */}
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: "34cqh", zIndex: 6 }}>
          <div style={{ position: "absolute", left: 0, right: 0, top: "1cqh", height: "27cqh", overflow: "hidden" }}>
            <div
              style={{
                display: "flex",
                gap: `${gap}cqw`,
                position: "absolute",
                left: 0,
                top: "50%",
                transform: `translate(${trackOffset}cqw,-50%)`,
                transition: "transform .4s cubic-bezier(.2,.8,.2,1)",
              }}
            >
              {systems.map((sys, i) => {
                const isSel = i === clampedIndex;
                return (
                  <div
                    key={sys.id}
                    onClick={() => {
                      setSelectedIndex(i);
                      if (isSel) openSystem(sys);
                    }}
                    style={{
                      position: "relative",
                      overflow: "hidden",
                      background: fallbackTileBg(sys.id),
                      width: `${tileW}cqw`,
                      height: `${tileW}cqw`,
                      minWidth: 104,
                      minHeight: 104,
                      borderRadius: isSel ? "0.8cqh" : 0,
                      cursor: "pointer",
                      flex: "0 0 auto",
                      zIndex: isSel ? 2 : 1,
                      opacity: isSel ? 1 : 0.88,
                      border: isSel ? `3px solid ${THEME.accent}` : "3px solid transparent",
                      boxShadow: isSel ? `0 1cqh 2.2cqh ${THEME.accentGlow}` : "none",
                      transition: "opacity .25s ease, box-shadow .25s ease, border-radius .25s ease",
                    }}
                  >
                    <img
                      src={systemCarouselIconUrl(sys.id)}
                      alt=""
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
                      }}
                    />
                    <div
                      style={{
                        position: "absolute",
                        left: "50%",
                        bottom: "0.6cqh",
                        pointerEvents: "none",
                        transform: "translateX(-50%)",
                        whiteSpace: "nowrap",
                        background: THEME.carouselTextBg,
                        color: THEME.carouselText,
                        fontWeight: 800,
                        fontSize: "0.72cqw",
                        letterSpacing: "0.05em",
                        textTransform: "uppercase",
                        padding: "0.7cqh 0.9cqw",
                        borderRadius: 999,
                        boxShadow: "0 0.4cqh 1cqh rgba(0,0,0,0.18)",
                      }}
                    >
                      {sys.name}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div
            style={{
              position: "absolute",
              left: "4cqw",
              bottom: "3cqh",
              color: THEME.inkMuted,
              fontWeight: 800,
              fontSize: "0.95cqw",
              letterSpacing: "0.05em",
              textTransform: "uppercase",
            }}
          >
            {selected.kind === "desktop" ? "Remote control your PC" : `${selected.games.length} Games Available`}
          </div>

          <div style={{ position: "absolute", right: "4cqw", bottom: "3cqh", display: "flex", gap: "1.1cqw" }}>
            {HOME_HELP.map((h, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: "0.5cqw", color: THEME.inkMuted, fontWeight: 700, fontSize: "0.85cqw" }}>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    minWidth: "1.9cqw",
                    height: "1.9cqw",
                    padding: "0 0.3cqw",
                    borderRadius: "0.5cqw",
                    background: THEME.helpBg,
                    color: THEME.ink,
                    fontSize: "0.8cqw",
                  }}
                >
                  {h.icon}
                </span>
                {h.label}
              </div>
            ))}
            <button
              onClick={handleScan}
              disabled={scanning}
              style={{
                background: "transparent",
                border: "none",
                color: THEME.inkMuted,
                fontWeight: 700,
                fontSize: "0.85cqw",
                cursor: "pointer",
              }}
            >
              {scanning ? "Scanning…" : "⟳ Rescan"}
            </button>
          </div>
        </div>

        {view === "game-list" && selected && (
          <GameListView
            theme={THEME}
            systemId={selected.id}
            systemName={selected.name}
            games={selected.games}
            selectedIndex={Math.min(selectedGameIndex, Math.max(0, selected.games.length - 1))}
            onSelect={setSelectedGameIndex}
            onLaunch={launchGame}
            onBack={backToHome}
            helpEntries={LIST_HELP}
          />
        )}
      </div>
    </div>
  );
}
