import { useEffect, useRef, useState } from "react";
import { Login } from "./pages/Login.js";
import { Settings } from "./pages/Settings.js";

type View = "loading" | "login" | "settings" | "redirecting";

const STREAM_PATH = "/stream/";

export function App() {
  const [view, setView] = useState<View>("loading");
  // Read once, outside the effect: React 18 StrictMode double-invokes effects
  // in dev, and history.replaceState below strips ?view=settings from the
  // URL on the first run — a second read of location.search on the replay
  // would find it already gone and wrongly fall through to the stream
  // redirect.
  const wantsSettings = useRef(
    new URLSearchParams(location.search).get("view") === "settings"
  ).current;

  useEffect(() => {
    if (wantsSettings) history.replaceState(null, "", location.pathname);

    fetch("/api/me")
      .then((res) => {
        if (!res.ok) {
          setView("login");
          return;
        }
        // The tray's "Settings" item opens the portal with ?view=settings so
        // it lands directly on the settings page instead of immediately
        // handing off to the stream.
        if (wantsSettings) {
          setView("settings");
          return;
        }
        goToStream();
      })
      .catch(() => setView("login"));
  }, [wantsSettings]);

  function goToStream() {
    setView("redirecting");
    // Full navigation, not client-side routing — moonlight-web-stream is a
    // full app with its own fullscreen video/input handling served by the
    // server's /stream reverse proxy, not something this React app renders.
    window.location.href = STREAM_PATH;
  }

  if (view === "loading" || view === "redirecting") {
    return <div className="center">Loading…</div>;
  }
  if (view === "login") return <Login onLoggedIn={goToStream} />;

  return <Settings onBack={goToStream} />;
}
