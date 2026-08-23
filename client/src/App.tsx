import { useEffect, useRef, useState } from "react";
import { Login } from "./pages/Login.js";
import { Settings } from "./pages/Settings.js";

type View = "loading" | "login" | "settings" | "redirecting";

const STREAM_PATH = "/stream/";

// The session cookie is deliberately non-Secure (see server/src/web/
// session.ts) because this app is meant to be reached over plain HTTP on
// a LAN. If someone port-forwards this port straight to the internet —
// a very plausible move for a "stream my PC" app — that cookie (and the
// login password) would travel in the clear to anyone on the path. The
// server itself can't detect port-forwarding (that's invisible NAT
// state on the router), but the browser knows what hostname it actually
// used to get here, which is a reasonable proxy: if it's plain HTTP and
// the hostname isn't a loopback/private/.local address, something is
// very likely forwarding this port publicly.
function isLikelyExposedToInternet(): boolean {
  if (location.protocol !== "http:") return false;
  const host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
  if (host.endsWith(".local")) return false;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
  return true;
}

function InsecureAccessWarning() {
  if (!isLikelyExposedToInternet()) return null;
  return (
    <div className="insecure-warning">
      This looks like it might be reachable from outside your home network over plain HTTP.
      LumaArcade's login isn't designed to be exposed to the internet directly — your password
      and session would travel unencrypted. Put it behind a VPN or a reverse proxy with HTTPS
      instead of forwarding this port on your router.
    </div>
  );
}

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
  if (view === "login") {
    return (
      <>
        <InsecureAccessWarning />
        <Login onLoggedIn={goToStream} />
      </>
    );
  }

  return (
    <>
      <InsecureAccessWarning />
      <Settings onBack={goToStream} />
    </>
  );
}
