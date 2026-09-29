import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { registerHttpsRoutes, startHttps } from "./https.js";

// A throwaway self-signed certificate generated in-memory, so this test does
// not depend on the machine certificate store being available.
function makeCertificate(dir: string, passphrase: string): void {
  const script = `
$ErrorActionPreference = 'Stop'
$subject = [System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new('CN=Luma Arcade test')
$rsa = [System.Security.Cryptography.RSA]::Create(2048)
try {
  $req = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    $subject,
    $rsa,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
  )
  $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  $san.AddDnsName('localhost')
  $san.AddIpAddress([System.Net.IPAddress]::Parse('127.0.0.1'))
  $req.CertificateExtensions.Add($san.Build())
  $cert = $req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddDays(30))
  try {
    [System.IO.File]::WriteAllBytes('${path.join(dir, "https", "luma.pfx")}', $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, '${passphrase}'))
    [System.IO.File]::WriteAllBytes('${path.join(dir, "https", "luma-arcade.cer")}', $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
  } finally {
    $cert.Dispose()
  }
} finally {
  $rsa.Dispose()
}
`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "pipe" });
}

function get(port: number, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    https
      .get({ host: "127.0.0.1", port, path: urlPath, rejectUnauthorized: false }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

describe("HTTPS for the home network", { skip: process.platform !== "win32" }, () => {
  let dir: string;
  let app: FastifyInstance;
  let port: number;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "luma-https-"));
    execFileSync("cmd.exe", ["/c", "mkdir", path.join(dir, "https")]);
    makeCertificate(dir, "test-passphrase");
    port = 40000 + Math.floor(Math.random() * 20000);
    writeFileSync(
      path.join(dir, "https.json"),
      "﻿" + JSON.stringify({ port, pfx: "https\\luma.pfx", passphrase: "test-passphrase", cert: "https\\luma-arcade.cer" })
    );
    app = Fastify();
    app.get("/who", async (req) => ({ protocol: req.protocol, ip: req.ip }));
    await registerHttpsRoutes(app, dir);
    await app.listen({ port: 0, host: "127.0.0.1" });
    assert.equal(await startHttps(app, dir), port);
  });

  after(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves the same routes over TLS, with the device's own address", async () => {
    const res = await get(port, "/who");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { protocol: "https", ip: "127.0.0.1" });
  });

  it("passes WebSocket upgrades through (the stream's connection)", async () => {
    const onUpgrade = (_req: unknown, socket: import("node:net").Socket) =>
      socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    app.server.on("upgrade", onUpgrade);
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = https.request({
          host: "127.0.0.1",
          port,
          path: "/ws",
          rejectUnauthorized: false,
          headers: { Connection: "Upgrade", Upgrade: "websocket" },
        });
        req.on("upgrade", (res, socket) => {
          socket.destroy();
          resolve(res.statusCode ?? 0);
        });
        req.on("response", (res) => resolve(res.statusCode ?? 0));
        req.on("error", reject);
        req.end();
      });
      assert.equal(status, 101);
    } finally {
      app.server.off("upgrade", onUpgrade);
    }
  });

  it("hands out the certificate, without the key", async () => {
    const res = await get(port, "/luma-arcade.cer");
    assert.equal(res.status, 200);
    assert.ok(res.body.length > 100);
  });

  it("does nothing without https.json", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "luma-https-none-"));
    try {
      assert.equal(await startHttps(app, empty), null);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
