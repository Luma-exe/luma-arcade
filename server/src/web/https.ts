import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import tls from "node:tls";

// HTTPS for the home network. Browsers only let a page use game controllers
// and full screen over HTTPS (or on localhost), so a TV or laptop opening
// http://<this PC>:7777 can't play with a controller. The installer
// (installer/scripts/setup-network.ps1) makes a certificate for this PC and
// writes server/https.json:
//   { "port": 7778, "pfx": "https\\luma.pfx", "passphrase": "...", "cert": "https\\luma-arcade.cer" }
// The same site is then served on that port too. The certificate is
// self-signed: each device warns once, or trusts it for good after
// installing /luma-arcade.cer.

export interface HttpsConfig {
  port: number;
  /** relative to the server folder */
  pfx: string;
  passphrase: string;
  /** the certificate alone (no key), for devices to install */
  cert?: string;
}

export function readHttpsConfig(serverDir: string): HttpsConfig | null {
  const file = path.join(serverDir, "https.json");
  if (!existsSync(file)) return null;
  const config = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as HttpsConfig;
  if (!config.port || !config.pfx) return null;
  return config;
}

/**
 * Serves `app` over TLS on the configured port as well: each decrypted
 * connection is handed to the same HTTP server, so every route, the
 * moonlight proxy and its WebSockets work unchanged, and request.ip is the
 * device's real address (a proxy in between would make every visitor look
 * like this PC). Returns the port, or null when HTTPS isn't set up.
 */
export async function startHttps(app: FastifyInstance, serverDir: string): Promise<number | null> {
  const config = readHttpsConfig(serverDir);
  if (!config) return null;
  const sockets = new Set<tls.TLSSocket>();
  const server = tls.createServer(
    {
      pfx: readFileSync(path.join(serverDir, config.pfx)),
      passphrase: config.passphrase,
      ALPNProtocols: ["http/1.1"],
    },
    (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      app.server.emit("connection", socket);
    }
  );
  // A device that gives up on the certificate warning resets the handshake.
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  // Closing the app closes this too (kept-alive connections would hold a
  // plain close up forever).
  app.server.once("close", () => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return config.port;
}

/** The certificate (public, no key) for devices that want to trust it. */
export async function registerHttpsRoutes(app: FastifyInstance, serverDir: string) {
  app.get("/luma-arcade.cer", async (_req, reply) => {
    const config = readHttpsConfig(serverDir);
    const file = config?.cert ? path.join(serverDir, config.cert) : null;
    if (!file || !existsSync(file)) return reply.code(404).send({ error: "HTTPS isn't set up on this PC" });
    return reply
      .type("application/x-x509-ca-cert")
      .header("content-disposition", 'attachment; filename="luma-arcade.cer"')
      .send(readFileSync(file));
  });
}
