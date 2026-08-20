/**
 * Consumer-side client for the gst-plugins-rs webrtcsink signalling protocol
 * (see server/src/signalling/server.ts for the matching relay implementation).
 */
export interface SignallingHandle {
  close: () => void;
  getPeerConnection: () => RTCPeerConnection | undefined;
}

export function connectToFullDesktopStream(
  videoEl: HTMLVideoElement,
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void,
  onError?: (details: string) => void
): SignallingHandle {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/signalling`);
  let pc: RTCPeerConnection | undefined;
  let sessionId: string | undefined;
  const iceServersPromise = fetch("/api/webrtc-config")
    .then((r) => r.json())
    .then((data) => data.iceServers as RTCIceServer[])
    .catch(() => [] as RTCIceServer[]);

  function send(msg: Record<string, unknown>) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  ws.onopen = () => {
    send({ type: "setPeerStatus", roles: ["consumer"] });
    send({ type: "startSession" });
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case "sessionStarted": {
        sessionId = msg.sessionId;
        break;
      }

      case "peer": {
        if (!sessionId) sessionId = msg.sessionId;

        if (msg.sdp?.type === "offer") {
          const iceServers = await iceServersPromise;
          pc = new RTCPeerConnection({ iceServers });
          pc.ontrack = (e) => {
            videoEl.srcObject = e.streams[0];
          };
          pc.onicecandidate = (e) => {
            if (e.candidate) {
              send({
                type: "peer",
                sessionId,
                ice: {
                  candidate: e.candidate.candidate,
                  sdpMLineIndex: e.candidate.sdpMLineIndex ?? 0,
                },
              });
            }
          };
          pc.onconnectionstatechange = () => {
            if (pc) onConnectionStateChange?.(pc.connectionState);
          };

          await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp.sdp });
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          send({ type: "peer", sessionId, sdp: { type: "answer", sdp: answer.sdp } });
        } else if (msg.ice && pc) {
          await pc.addIceCandidate({
            candidate: msg.ice.candidate,
            sdpMLineIndex: msg.ice.sdpMLineIndex,
          });
        }
        break;
      }

      case "endSession": {
        pc?.close();
        break;
      }

      case "error": {
        onError?.(msg.details ?? "unknown signalling error");
        break;
      }

      default:
        break;
    }
  };

  return {
    close: () => {
      if (sessionId) send({ type: "endSession", sessionId });
      pc?.close();
      ws.close();
    },
    getPeerConnection: () => pc,
  };
}
