import type { FastifyInstance } from "fastify";
import { getStunTurnConfig } from "../../remote/iceServers.js";
import { requireAuth } from "../session.js";

export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export function toRtcIceServers(config: ReturnType<typeof getStunTurnConfig>): IceServerConfig[] {
  const servers: IceServerConfig[] = [];
  if (config.stunServer) {
    servers.push({ urls: [config.stunServer.replace("stun://", "stun:")] });
  }
  if (config.turnServer) {
    const match = /^turn:\/\/([^:]+):([^@]+)@(.+)$/.exec(config.turnServer);
    if (match) {
      const [, username, credential, hostPort] = match;
      servers.push({ urls: [`turn:${hostPort}`], username, credential });
    }
  }
  return servers;
}

export async function registerWebrtcConfigRoutes(app: FastifyInstance) {
  app.get("/api/webrtc-config", { preHandler: requireAuth }, async () => ({
    iceServers: toRtcIceServers(getStunTurnConfig()),
  }));
}
