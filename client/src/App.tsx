import { useEffect, useState } from "react";
import { Login } from "./pages/Login.js";
import { Library } from "./pages/Library.js";
import { Settings } from "./pages/Settings.js";
import { Stream } from "./pages/Stream.js";
import type { GameRow } from "./lib/api.js";

type View = "loading" | "login" | "library" | "settings" | "stream";

export function App() {
  const [view, setView] = useState<View>("loading");
  const [activeGame, setActiveGame] = useState<GameRow | null>(null);
  const [activePid, setActivePid] = useState<number | undefined>(undefined);

  useEffect(() => {
    fetch("/api/me")
      .then((res) => setView(res.ok ? "library" : "login"))
      .catch(() => setView("login"));
  }, []);

  if (view === "loading") return <div className="center">Loading…</div>;
  if (view === "login") return <Login onLoggedIn={() => setView("library")} />;
  if (view === "settings") return <Settings onBack={() => setView("library")} />;
  if (view === "stream")
    return (
      <Stream
        game={activeGame}
        pid={activePid}
        onExit={() => {
          setActiveGame(null);
          setActivePid(undefined);
          setView("library");
        }}
      />
    );

  return (
    <Library
      onLaunchFullDesktop={() => {
        setActiveGame(null);
        setActivePid(undefined);
        setView("stream");
      }}
      onLaunchGame={(game, pid) => {
        setActiveGame(game);
        setActivePid(pid);
        setView("stream");
      }}
      onOpenSettings={() => setView("settings")}
    />
  );
}
