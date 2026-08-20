import { useEffect, useState } from "react";
import { api, type AppSettings, type GameRow } from "../lib/api.js";
import { GameGrid } from "../components/GameGrid.js";
import { ConsoleCarousel } from "../components/ConsoleCarousel.js";

type Source = "steam" | "epic" | "emulation" | "custom";

export function Library({
  onLaunchFullDesktop,
  onLaunchGame,
  onOpenSettings,
}: {
  onLaunchFullDesktop: () => void;
  onLaunchGame: (game: GameRow, pid?: number) => void;
  onOpenSettings: () => void;
}) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [view, setView] = useState<{ source: Source; console?: string } | null>(null);
  const [games, setGames] = useState<GameRow[]>([]);
  const [consoles, setConsoles] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [activeStream, setActiveStream] = useState<{
    mode: "desktop" | "game";
    gameId?: number;
    game?: GameRow;
    pid?: number;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    setLoadError(null);
    api
      .getSettings()
      .then(setSettings)
      .catch((err) => setLoadError((err as Error).message));
    api.getConsoles().then(setConsoles).catch(() => {});

    api
      .getStreamStatus()
      .then(async (status) => {
        if (!status.running) return;
        if (status.mode === "game" && status.gameId) {
          const all = await api.getGames();
          const game = all.find((g) => g.id === status.gameId);
          setActiveStream({ mode: "game", gameId: status.gameId, game, pid: status.pid });
        } else {
          setActiveStream({ mode: "desktop" });
        }
      })
      .catch(() => {});
  }, [reloadNonce]);

  function handleResume() {
    if (!activeStream) return;
    if (activeStream.mode === "game" && activeStream.game) {
      onLaunchGame(activeStream.game, activeStream.pid);
    } else {
      onLaunchFullDesktop();
    }
  }

  useEffect(() => {
    if (!view) return;
    api.getGames(view.source).then((all) => {
      setGames(view.console ? all.filter((g) => g.console === view.console) : all);
    });
  }, [view]);

  async function handleScan() {
    setScanning(true);
    try {
      await api.scanLibrary();
      if (view) {
        const all = await api.getGames(view.source);
        setGames(view.console ? all.filter((g) => g.console === view.console) : all);
      }
      setConsoles(await api.getConsoles());
    } finally {
      setScanning(false);
    }
  }

  async function handleLaunch(game: GameRow) {
    const result = await api.launchGame(game.id);
    onLaunchGame(game, result.pid);
  }

  if (loadError) {
    return (
      <div className="center">
        <div className="auth-card">
          <p className="error">Couldn't reach LumaArcade: {loadError}</p>
          <button onClick={() => setReloadNonce((n) => n + 1)}>Retry</button>
        </div>
      </div>
    );
  }

  if (!settings) return <div className="center">Loading…</div>;

  return (
    <div className="library-page">
      <header className="library-header">
        <h1>LumaArcade</h1>
        <div className="header-actions">
          <button onClick={handleScan} disabled={scanning}>
            {scanning ? "Scanning…" : "Rescan library"}
          </button>
          <button onClick={onOpenSettings}>Settings</button>
        </div>
      </header>

      {activeStream && !view && (
        <div className="resume-banner">
          <span>
            A stream is already running
            {activeStream.mode === "game" && activeStream.game
              ? ` — ${activeStream.game.title}`
              : " — Full Desktop"}
            .
          </span>
          <button onClick={handleResume}>Resume Stream</button>
        </div>
      )}

      {!view && (
        <div className="source-tiles">
          {settings.fullDesktopEnabled && (
            <button className="tile" onClick={onLaunchFullDesktop}>
              Full Desktop
            </button>
          )}
          {settings.steamEnabled && (
            <button className="tile" onClick={() => setView({ source: "steam" })}>
              Steam
            </button>
          )}
          {settings.epicEnabled && (
            <button className="tile" onClick={() => setView({ source: "epic" })}>
              Epic Games
            </button>
          )}
          {settings.emulationEnabled && (
            <button className="tile" onClick={() => setView({ source: "emulation" })}>
              Emulation
            </button>
          )}
          {settings.customAppsEnabled && (
            <button className="tile" onClick={() => setView({ source: "custom" })}>
              Custom Apps
            </button>
          )}
        </div>
      )}

      {view && view.source === "emulation" && !view.console && (
        <div>
          <button className="back-link" onClick={() => setView(null)}>
            ← Back
          </button>
          <ConsoleCarousel
            consoles={consoles}
            onSelect={(console) => setView({ source: "emulation", console })}
          />
        </div>
      )}

      {view && (view.source !== "emulation" || view.console) && (
        <div>
          <button
            className="back-link"
            onClick={() =>
              view.source === "emulation" && view.console
                ? setView({ source: "emulation" })
                : setView(null)
            }
          >
            ← Back
          </button>
          <GameGrid games={games} onLaunch={handleLaunch} />
        </div>
      )}
    </div>
  );
}
