import { useEffect, useRef, useState } from "react";
import { connectToFullDesktopStream, type SignallingHandle } from "../lib/signalling.js";
import { attachInputCapture } from "../lib/input.js";
import { sampleConnectionStats, type ConnectionStats } from "../lib/connectionStats.js";
import { api, type GameRow } from "../lib/api.js";

export function Stream({
  onExit,
  game,
  pid,
}: {
  onExit: () => void;
  game?: GameRow | null;
  pid?: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState>("new");
  const [mode, setMode] = useState<"desktop" | "game">(game ? "game" : "desktop");
  const [stats, setStats] = useState<ConnectionStats | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const signallingRef = useRef<SignallingHandle | null>(null);

  function reconnectSignalling() {
    const video = videoRef.current;
    if (!video) return;
    cleanupRef.current?.();
    setStreamError(null);
    const signalling = connectToFullDesktopStream(video, setConnectionState, (details) =>
      setStreamError(details)
    );
    const input = attachInputCapture(video);
    signallingRef.current = signalling;
    cleanupRef.current = () => {
      signalling.close();
      input.close();
    };
  }

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;

    fetch("/api/stream/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        width: window.screen.width,
        height: window.screen.height,
        gameId: game?.id,
        pid,
      }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`stream/start failed (${res.status})`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setMode(data.mode === "game" ? "game" : "desktop");
        reconnectSignalling();
      })
      .catch((err) => {
        if (!cancelled) setStreamError((err as Error).message);
      });

    return () => {
      cancelled = true;
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

  async function handleSwitchToDesktop() {
    await api.switchToDesktop();
    setMode("desktop");
    reconnectSignalling();
  }

  return (
    <div className="stream-view">
      <video ref={videoRef} autoPlay playsInline muted className="stream-video" />
      {streamError && (
        <div className="stream-error-overlay">
          <p>Stream unavailable: {streamError}</p>
          <p className="muted">
            This usually means GStreamer isn't installed or on PATH — see the README's
            Prerequisites section.
          </p>
          <button onClick={reconnectSignalling}>Retry</button>
        </div>
      )}
      <div className="hud">
        <span className={`status status-${connectionState}`}>{connectionState}</span>
        {stats && (
          <span className="stats muted">
            {Math.round(stats.bitrateKbps)} kbps
            {stats.rttMs !== null && ` · ${Math.round(stats.rttMs)}ms`}
            {stats.packetLossPct > 0.5 && ` · ${stats.packetLossPct.toFixed(1)}% loss`}
          </span>
        )}
        {mode === "game" && <button onClick={handleSwitchToDesktop}>Full Desktop</button>}
        <button onClick={onExit}>Back to Library</button>
      </div>
    </div>
  );
}
