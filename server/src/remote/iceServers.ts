import { getSetting } from "../config/settings.js";
import { generateTurnCredential } from "./coturn.js";

export interface StunTurnConfig {
  stunServer?: string;
  turnServer?: string;
}

/** Shared by both WebRTC peers: the browser (via /api/webrtc-config) and the
 * GStreamer producer (via pipeline arg building) need the same STUN/TURN info. */
export function getStunTurnConfig(): StunTurnConfig {
  const remoteEnabled = getSetting("remoteAccessEnabled");
  const turnEnabled = getSetting("turnServerEnabled");

  if (!remoteEnabled || !turnEnabled || !getSetting("turnSharedSecret")) {
    return { stunServer: "stun://stun.l.google.com:19302" };
  }

  const { username, credential } = generateTurnCredential();
  const host = getSetting("turnPublicHost") || "127.0.0.1";
  const port = getSetting("turnPort");

  return {
    stunServer: "stun://stun.l.google.com:19302",
    turnServer: `turn://${username}:${credential}@${host}:${port}`,
  };
}
