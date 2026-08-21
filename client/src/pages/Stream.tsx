import { useEffect, useRef, useState } from "react";
import { connectToFullDesktopStream, type SignallingHandle } from "../lib/signalling.js";
import { attachInputCapture } from "../lib/input.js";
import { sampleConnectionStats, type ConnectionStats } from "../lib/connectionStats.js";
import { api, type DisplayInfo, type GameRow } from "../lib/api.js";

export function Stream({
  onExit,
  game,
  pid,
  backLabel = "Back to Library",
}: {
  onExit: () => void;
  game?: GameRow | null;
  pid?: number;
  backLabel?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState>("new");
  const [mode, setMode] = useState<"desktop" | "game">(game ? "game" : "desktop");
  const [stats, setStats] = useState<ConnectionStats | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [genericHint, setGenericHint] = useState(true);
  const [controlLocked, setControlLocked] = useState(false);
  const [inputWarning, setInputWarning] = useState<string | null>(null);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [activeMonitor, setActiveMonitor] = useState(0);
  const [mouseDebug, setMouseDebug] = useState<{ count: number; sent: number; lastDx: number; lastDy: number }>({
    count: 0,
    sent: 0,
    lastDx: 0,
    lastDy: 0,
  });
  const [keyDebug, setKeyDebug] = useState<{ count: number; sent: number; lastKey: string }>({
    count: 0,
    sent: 0,
    lastKey: "",
  });
  const cleanupRef = useRef<(() => void) | null>(null);
  const signallingRef = useRef<SignallingHandle | null>(null);
  const mountedRef = useRef(true);

  function reconnectSignalling() {
    const video = videoRef.current;
    if (!video) return;
    cleanupRef.current?.();
    setStreamError(null);
    const signalling = connectToFullDesktopStream(video, setConnectionState, (details) => {
      setGenericHint(true);
      setStreamError(details);
    });
    const input = attachInputCapture(video, {
      onLockChange: setControlLocked,
      onSocketError: setInputWarning,
      onDebugMouseMove: ({ movementX, movementY, sent }) => {
        setMouseDebug((prev) => ({
          count: prev.count + 1,
          sent: prev.sent + (sent ? 1 : 0),
          lastDx: movementX,
          lastDy: movementY,
        }));
      },
      onDebugKey: ({ key, sent }) => {
        setKeyDebug((prev) => ({
          count: prev.count + 1,
          sent: prev.sent + (sent ? 1 : 0),
          lastKey: key,
        }));
      },
    });
    signallingRef.current = signalling;
    cleanupRef.current = () => {
      signalling.close();
      input.close();
    };
  }

  async function startStream(monitorIndex = activeMonitor) {
    setStreamError(null);
    try {
      const res = await fetch("/api/stream/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          width: window.screen.width,
          height: window.screen.height,
          gameId: game?.id,
          pid,
          monitorIndex,
        }),
      });
      if (!res.ok) throw new Error(`stream/start failed (${res.status})`);
      const data = await res.json();
      if (!mountedRef.current) return;
      setMode(data.mode === "game" ? "game" : "desktop");
      if (data.producerReady === false) {
        setGenericHint(false);
        setStreamError(
          "The capture pipeline didn't finish starting in time. It may still be initializing — try Retry in a few seconds."
        );
        return;
      }
      reconnectSignalling();
    } catch (err) {
      if (!mountedRef.current) return;
      setGenericHint(true);
      setStreamError((err as Error).message);
    }
  }

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    mountedRef.current = true;
    startStream().catch(() => {});
    api
      .getDisplays()
      .then((res) => mountedRef.current && setDisplays(res.displays))
      .catch(() => {});

    return () => {
      mountedRef.current = false;
      cleanupRef.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const interval = setInterval(async () => {
      const pc = signallingRef.current?.getPeerConnection();
      if (pc) setStats(await sampleConnectionStats(pc));
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  async function handleSwitchToDesktop(monitorIndex = activeMonitor) {
    await api.switchToDesktop(monitorIndex);
    setMode("desktop");
    setActiveMonitor(monitorIndex);
    reconnectSignalling();
  }

  async function handleSwitchMonitor(monitorIndex: number) {
    if (monitorIndex === activeMonitor) return;
    await handleSwitchToDesktop(monitorIndex);
  }

  return (
    <div className="stream-view">
      <video ref={videoRef} autoPlay playsInline muted className="stream-video" />
      {!streamError && !controlLocked && connectionState === "connected" && (
        <div className="control-prompt" onClick={() => videoRef.current?.requestPointerLock()}>
          Click to control mouse &amp; keyboard
        </div>
      )}
      {inputWarning && (
        <div className="input-warning muted" onClick={() => setInputWarning(null)}>
          {inputWarning} (click to dismiss)
        </div>
      )}
      {streamError && (
        <div className="stream-error-overlay">
          <p>Stream unavailable: {streamError}</p>
          {genericHint && (
            <p className="muted">
              This usually means GStreamer isn't installed or on PATH — see the README's
              Prerequisites section.
            </p>
          )}
          <button onClick={() => void startStream()}>Retry</button>
        </div>
      )}
      <div className="hud">
        <span className={`status status-${connectionState}`}>{connectionState}</span>
        <span className={`status ${controlLocked ? "status-connected" : ""}`}>
          {controlLocked ? "controlling" : "not in control"}
        </span>
        {controlLocked && (
          <span className="stats muted">
            mouse: {mouseDebug.count}/{mouseDebug.sent} sent, dx/dy {mouseDebug.lastDx}/{mouseDebug.lastDy} · key:{" "}
            {keyDebug.count}/{keyDebug.sent} sent, last "{keyDebug.lastKey}"
          </span>
        )}
        {stats && (
          <span className="stats muted">
            {Math.round(stats.bitrateKbps)} kbps
            {stats.rttMs !== null && ` · ${Math.round(stats.rttMs)}ms`}
            {stats.packetLossPct > 0.5 && ` · ${stats.packetLossPct.toFixed(1)}% loss`}
            {stats.candidateType && ` · ${stats.candidateType}`}
            {` · rx ${stats.packetsReceived}/lost ${stats.packetsLost}`}
          </span>
        )}
        {mode === "desktop" && displays.length > 1 && (
          <span className="monitor-tabs">
            {displays.map((d) => (
              <button
                key={d.index}
                className={d.index === activeMonitor ? "active" : ""}
                onClick={() => void handleSwitchMonitor(d.index)}
              >
                {d.width}×{d.height}
                {d.primary ? " (primary)" : ""}
              </button>
            ))}
          </span>
        )}
        {mode === "game" && <button onClick={() => void handleSwitchToDesktop()}>Full Desktop</button>}
        <button onClick={onExit}>{backLabel}</button>
      </div>
    </div>
  );
}
