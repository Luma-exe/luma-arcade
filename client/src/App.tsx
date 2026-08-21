import { useCallback, useEffect, useRef, useState } from "react";
import { Login } from "./pages/Login.js";
import { Home } from "./pages/Home.js";
import { Settings } from "./pages/Settings.js";
import { Stream } from "./pages/Stream.js";
import { api, type GameRow, type UpdateStatus } from "./lib/api.js";

type View = "loading" | "login" | "home" | "settings" | "stream" | "esde-error";

// How often to poll settings for a launch-mode change made elsewhere (the
// tray icon's "Switch to ES-DE/Standalone Mode" item) while this tab is
// sitting idle on the home screen or an ES-DE error card. The tray runs in
// a separate process from this browser tab with no other channel back to
// it, so polling is the simplest way for an already-open tab to notice.
const LAUNCH_MODE_POLL_MS = 3000;

// Matches the server's own poll cadence (rdpWatch.ts) — no point checking
// more often than the underlying state can actually change.
const RDP_POLL_MS = 4000;
const RDP_REPAIRED_MESSAGE_MS = 6000;

export function App() {
  const [view, setView] = useState<View>("loading");
  const [activeGame, setActiveGame] = useState<GameRow | null>(null);
  const [activePid, setActivePid] = useState<number | undefined>(undefined);
  const [esdeError, setEsdeError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [rdpConnected, setRdpConnected] = useState(false);
  const [rdpJustRepaired, setRdpJustRepaired] = useState(false);
  const [streamKey, setStreamKey] = useState(0);
  const lastLaunchMode = useRef<"standalone" | "esde" | null>(null);
  const wasRdpConnected = useRef(false);

  // ES-DE launch mode: skip our own carousel entirely and go straight into a
  // window-captured view of the real, natively-installed ES-DE (launching it,
  // or attaching to it if already running). Standalone just shows our home.
  const applyLaunchMode = useCallback(async () => {
    const settings = await api.getSettings().catch(() => null);
    if (!settings) return;
    lastLaunchMode.current = settings.launchMode;

    if (settings.launchMode === "esde") {
      const result = await api.esdeLaunch().catch((err: Error) => ({
        ok: false as const,
        error: err.message,
        pid: undefined,
      }));
      if (result.ok) {
        setActiveGame(null);
        setActivePid(result.pid);
        setView("stream");
        return;
      }
      setEsdeError(result.error ?? "Failed to launch ES-DE.");
      setView("esde-error");
      return;
    }
    setView("home");
  }, []);

  useEffect(() => {
    fetch("/api/me")
      .then((res) => {
        if (!res.ok) {
          setView("login");
          return;
        }
        // The tray's "Settings" item opens the portal with ?view=settings so
        // it lands directly on the settings page instead of launching
        // straight into ES-DE mode or the home carousel.
        if (new URLSearchParams(location.search).get("view") === "settings") {
          history.replaceState(null, "", location.pathname);
          setView("settings");
          return;
        }
        // Fire-and-forget: never block getting into the app on a GitHub API
        // call, and a failed check (offline, rate-limited) just means no
        // banner rather than an error the user has to deal with.
        api.checkForUpdate().then(setUpdateStatus).catch(() => {});
        return applyLaunchMode();
      })
      .catch(() => setView("login"));
  }, [applyLaunchMode]);

  // Pick up a mode switch made from the tray icon while this tab is idle.
  // Skipped mid-game/mid-desktop-stream so we never yank control away from
  // something the user is actively playing.
  useEffect(() => {
    if (view !== "home" && view !== "esde-error") return;
    const interval = setInterval(async () => {
      const settings = await api.getSettings().catch(() => null);
      if (settings && settings.launchMode !== lastLaunchMode.current) {
        applyLaunchMode();
      }
    }, LAUNCH_MODE_POLL_MS);
    return () => clearInterval(interval);
  }, [view, applyLaunchMode]);

  // Remote Desktop briefly takes over rendering while connected, which can
  // disturb an in-progress capture even with the virtual display driver
  // installed — surface it so the user knows why streaming might be rough
  // right now, and auto-recover once it disconnects instead of leaving them
  // to notice and manually retry.
  useEffect(() => {
    const interval = setInterval(async () => {
      const status = await api.getRdpStatus().catch(() => null);
      if (!status) return;
      setRdpConnected(status.connected);

      if (wasRdpConnected.current && !status.connected) {
        setRdpJustRepaired(true);
        setTimeout(() => setRdpJustRepaired(false), RDP_REPAIRED_MESSAGE_MS);
        // Force the stream view to remount and reconnect from scratch —
        // the server already re-applied the display fix on its side the
        // moment it saw the disconnect.
        if (view === "stream") setStreamKey((k) => k + 1);
      }
      wasRdpConnected.current = status.connected;
    }, RDP_POLL_MS);
    return () => clearInterval(interval);
  }, [view]);

  if (view === "loading") return <div className="center">Loading…</div>;
  if (view === "login") return <Login onLoggedIn={() => applyLaunchMode()} />;

  const showUpdateBanner = updateStatus?.updateAvailable && !updateDismissed && view !== "settings";

  let body: React.ReactNode;
  if (view === "settings") {
    body = <Settings onBack={() => applyLaunchMode()} />;
  } else if (view === "esde-error") {
    body = (
      <div className="center">
        <div className="auth-card">
          <p className="error">Couldn't start ES-DE: {esdeError}</p>
          <p className="muted">
            Check the ES-DE executable path in Settings, or switch back to Standalone mode
            from the tray icon.
          </p>
          <button onClick={() => setView("home")}>Open LumaArcade Home instead</button>
        </div>
      </div>
    );
  } else if (view === "stream") {
    body = (
      <Stream
        key={streamKey}
        game={activeGame}
        pid={activePid}
        backLabel={lastLaunchMode.current === "esde" ? "Back to ES-DE" : "Back to Library"}
        onExit={() => {
          setActiveGame(null);
          setActivePid(undefined);
          // applyLaunchMode() in ES-DE mode re-attaches and lands back on
          // view "stream" -- same view, so React wouldn't otherwise remount
          // <Stream>, leaving the click with no visible effect at all (no
          // reconnect, no status change, nothing). Bumping the key forces a
          // fresh mount, which itself doubles as the "it worked" feedback:
          // status drops back to "new" and climbs to "connected" again.
          setStreamKey((k) => k + 1);
          applyLaunchMode();
        }}
      />
    );
  } else {
    body = (
      <Home
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

  return (
    <>
      <div className="banner-stack">
        {rdpConnected && (
          <div className="update-banner rdp-banner">
            <span>
              Someone is connected to this PC via Remote Desktop — this can disrupt streaming.
              Disconnect that session to restore a stable connection.
            </span>
          </div>
        )}
        {!rdpConnected && rdpJustRepaired && (
          <div className="update-banner">
            <span>Remote Desktop disconnected — reconnecting the stream…</span>
          </div>
        )}
        {showUpdateBanner && (
          <div className="update-banner">
            <span>
              An update is available (commit {updateStatus!.latestCommit?.slice(0, 7)}).
            </span>
            <button onClick={() => setView("settings")}>Go to Settings</button>
            <button onClick={() => setUpdateDismissed(true)}>Dismiss</button>
          </div>
        )}
      </div>
      {body}
    </>
  );
}
