import type { FastifyInstance } from "fastify";
import { getStunTurnConfig } from "../../remote/iceServers.js";
import { toRtcIceServers } from "./webrtcConfig.js";

/**
 * Fetched by the Electron producer's main process (server/producer-electron
 * -- see server/src/capture/browserProducer.ts for why the video capture
 * path is a hidden Electron window instead of a GStreamer pipeline).
 * Loopback-only by convention: the signalling WebSocket it connects to
 * already exempts 127.0.0.1 from needing a session cookie (see
 * authorizedForSignalling in web/server.ts), so this route doesn't need its
 * own auth either -- only something already running on this machine can
 * ever reach it, since it's never linked from the portal UI.
 */
export async function registerProducerRoutes(app: FastifyInstance, opts: { port: number }) {
  app.get("/internal/producer-config", async () => ({
    signallingUri: `ws://127.0.0.1:${opts.port}/signalling`,
    iceServers: toRtcIceServers(getStunTurnConfig()),
  }));
}
