import { useEffect, useState } from "react";
import { Login } from "./pages/Login.js";

type View = "loading" | "login" | "redirecting";

const STREAM_PATH = "/stream/";

// Settings (stream quality, host health, LumaArcade's own server settings)
// all live in moonlight-web-stream's settings screen, which opens straight
// on Settings when given ?view=settings. The tray's "Settings" item links
// to this portal with that parameter, so pass it through.
const WANTS_SETTINGS = new URLSearchParams(location.search).get("view") === "settings";

export function App() {
  const [view, setView] = useState<View>("loading");

  useEffect(() => {
    fetch("/api/me")
      .then((res) => {
        if (!res.ok) {
          setView("login");
          return;
        }
        goToStream();
      })
      .catch(() => setView("login"));
  }, []);

  function goToStream() {
    setView("redirecting");
    // Full navigation, not client-side routing — moonlight-web-stream is a
    // full app with its own fullscreen video/input handling served by the
    // server's /stream reverse proxy, not something this React app renders.
    window.location.href = WANTS_SETTINGS ? `${STREAM_PATH}?view=settings` : STREAM_PATH;
  }

  if (view === "loading" || view === "redirecting") {
    return <div className="center">Loading…</div>;
  }
  return <Login onLoggedIn={goToStream} />;
}
