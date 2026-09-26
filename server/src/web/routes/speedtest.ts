import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { requireAuth } from "../session.js";

// Random, so nothing along the way (Cloudflare, a proxy) can compress it and
// make the connection look faster than it is.
const CHUNK = randomBytes(256 * 1024);
const MAX_BYTES = 64 * 1024 * 1024;

/** Download target for the stream settings' "Auto-detect" button, which
 * times it to pick a bitrate/resolution this connection can carry.
 * ?bytes=0 is a bare round trip for measuring latency. */
export async function registerSpeedtestRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { bytes?: string } }>(
    "/api/speedtest",
    { preHandler: requireAuth },
    async (req, reply) => {
      const requested = Number(req.query.bytes ?? 0);
      const total = Number.isFinite(requested) ? Math.min(Math.max(0, Math.floor(requested)), MAX_BYTES) : 0;

      reply
        .header("Cache-Control", "no-store")
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", String(total));
      if (total === 0) {
        return reply.send(Buffer.alloc(0));
      }

      let sent = 0;
      const body = new Readable({
        read() {
          if (sent >= total) {
            this.push(null);
            return;
          }
          const size = Math.min(CHUNK.length, total - sent);
          sent += size;
          this.push(size === CHUNK.length ? CHUNK : CHUNK.subarray(0, size));
        },
      });
      return reply.send(body);
    }
  );
}
