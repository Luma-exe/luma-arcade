import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * Implements the gst-plugins-rs webrtcsink signalling protocol
 * (net/webrtc/protocol crate: IncomingMessage / OutgoingMessage, camelCase JSON).
 * GStreamer's webrtcsink (Producer) and the browser client (Consumer) both
 * connect here as plain peers; this server just registers peers, tracks the
 * one Full-Desktop producer, and relays SDP/ICE "peer" messages between the
 * two sides of a session.
 */

type PeerRole = "producer" | "consumer" | "listener";

interface Peer {
  id: string;
  ws: WebSocket;
  role?: PeerRole;
}

interface Session {
  id: string;
  producerPeerId: string;
  consumerPeerId: string;
}

const peers = new Map<string, Peer>();
const sessions = new Map<string, Session>();
let producerPeerId: string | undefined;

function send(ws: WebSocket, message: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function handleMessage(peer: Peer, raw: string): void {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    send(peer.ws, { type: "error", details: "invalid JSON" });
    return;
  }

  switch (msg.type) {
    case "setPeerStatus": {
      const roles: PeerRole[] = msg.roles ?? [];
      if (roles.includes("producer")) {
        peer.role = "producer";
        producerPeerId = peer.id;
      } else if (roles.includes("consumer")) {
        peer.role = "consumer";
      }
      break;
    }

    case "list": {
      send(peer.ws, {
        type: "list",
        producers: producerPeerId ? [{ id: producerPeerId, meta: {} }] : [],
      });
      break;
    }

    case "startSession": {
      // Consumer asking to start watching a producer.
      const targetProducerId: string | undefined = msg.peerId ?? producerPeerId;
      if (!targetProducerId || !peers.has(targetProducerId)) {
        send(peer.ws, { type: "error", details: "no such producer" });
        break;
      }
      const producer = peers.get(targetProducerId)!;
      const sessionId = randomUUID();
      sessions.set(sessionId, {
        id: sessionId,
        producerPeerId: targetProducerId,
        consumerPeerId: peer.id,
      });

      console.log(`[signalling] session ${sessionId} starting: consumer=${peer.id} -> producer=${targetProducerId}`);
      // Tell the producer a new session started so it creates an SDP offer.
      send(producer.ws, { type: "startSession", peerId: peer.id, sessionId });
      // Confirm to the consumer.
      send(peer.ws, { type: "sessionStarted", peerId: targetProducerId, sessionId });
      break;
    }

    case "endSession": {
      const sessionId: string | undefined = msg.sessionId;
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        const other = peers.get(
          peer.id === session.producerPeerId ? session.consumerPeerId : session.producerPeerId
        );
        if (other) send(other.ws, { type: "endSession", sessionId });
        sessions.delete(sessionId);
      }
      break;
    }

    case "peer": {
      // SDP/ICE relay — forward verbatim to the other party in the session.
      const sessionId: string = msg.sessionId;
      const session = sessions.get(sessionId);
      if (!session) {
        send(peer.ws, { type: "error", details: "unknown session" });
        break;
      }
      const otherPeerId =
        peer.id === session.producerPeerId ? session.consumerPeerId : session.producerPeerId;
      const other = peers.get(otherPeerId);
      if (msg.sdp) {
        console.log(`[signalling] session ${sessionId}: relaying ${msg.sdp.type} from ${peer.role ?? "?"}`);
      }
      if (other) {
        send(other.ws, msg);
      } else {
        console.warn(`[signalling] session ${sessionId}: peer ${otherPeerId} not found, message dropped`);
      }
      break;
    }

    default:
      break;
  }
}

/** Whether the GStreamer producer has connected to the signalling server
 * and registered itself — used to make /api/stream/start wait for the
 * pipeline to actually be ready before telling the browser to connect,
 * instead of racing it (spawning gst-launch-1.0 doesn't mean webrtcsink has
 * finished initializing D3D11/CUDA contexts and registered yet, which
 * observably takes 1-3+ seconds). */
export function isProducerRegistered(): boolean {
  return producerPeerId !== undefined;
}

export interface SignallingAuthCheck {
  (request: IncomingMessage): boolean;
}

export function createSignallingServer(authCheck: SignallingAuthCheck): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, request) => {
    if (!authCheck(request)) {
      console.warn(`[signalling] rejected connection from ${request.socket.remoteAddress}`);
      ws.close(4401, "unauthorized");
      return;
    }

    const id = randomUUID();
    const peer: Peer = { id, ws };
    peers.set(id, peer);
    send(ws, { type: "welcome", peerId: id });

    ws.on("message", (data) => handleMessage(peer, data.toString()));

    ws.on("error", (err) => {
      console.warn(`[signalling] peer ${id} (${peer.role ?? "unknown"}) socket error:`, err.message);
    });

    ws.on("close", (code, reason) => {
      if (id === producerPeerId) {
        console.warn(
          `[signalling] producer disconnected: code=${code} reason=${reason.toString() || "(none)"}`
        );
      }
      peers.delete(id);
      if (producerPeerId === id) producerPeerId = undefined;
      for (const [sessionId, session] of sessions) {
        if (session.producerPeerId === id || session.consumerPeerId === id) {
          const otherId =
            id === session.producerPeerId ? session.consumerPeerId : session.producerPeerId;
          const other = peers.get(otherId);
          if (other) send(other.ws, { type: "endSession", sessionId });
          sessions.delete(sessionId);
        }
      }
    });
  });

  return wss;
}
