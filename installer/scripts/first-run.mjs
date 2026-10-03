// The setup steps that used to be manual (run by the installer with the
// bundled node.exe, elevated):
//   1. the first Luma Arcade account, which becomes the admin;
//   2. adding this PC (Sunshine at localhost) and pairing it, typing the
//      PIN into Sunshine with the admin's Sunshine sign-in;
//   3. letting every account use that PC.
// moonlight-web-stream does the Luma side, so it's started on its own for
// the duration (on a spare port, loopback only), exactly as Luma Arcade
// starts it later.
//
//   node first-run.mjs <install folder> <admin file>
// The admin file holds the name and the password on two lines (UTF-8 or
// UTF-16); it's deleted after reading. Nothing happens if moonlight already
// has accounts (an upgrade, or set up by hand).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";

const [installDir, adminFile] = process.argv.slice(2);
const moonlightDir = path.join(installDir ?? "", "moonlight-web-stream");
const SUNSHINE_API = { host: "127.0.0.1", port: 47990 };

const step = (text) => console.log(`==> ${text}`);
const note = (text) => console.log(`    ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readAdmin(file) {
  if (!file || !existsSync(file)) return null;
  const buf = readFileSync(file);
  rmSync(file, { force: true });
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2).toString("utf16le") : buf.toString("utf8").replace(/^﻿/, "");
  const [name, password] = text.split(/\r?\n/);
  return name && password ? { name, password } : null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Sunshine's web API (self-signed certificate on this PC). */
function sunshine(method, urlPath, admin, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = https.request(
      {
        ...SUNSHINE_API,
        method,
        path: urlPath,
        rejectUnauthorized: false,
        auth: `${admin.name}:${admin.password}`,
        headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {},
        timeout: 15_000,
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("Sunshine didn't answer")));
    req.on("error", reject);
    req.end(data);
  });
}

/** Reads a moonlight JSON-lines response one object at a time. */
function lineReader(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return async function next() {
    for (;;) {
      const nl = buffered.indexOf("\n");
      if (nl >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (line) return JSON.parse(line);
        continue;
      }
      const { value, done } = await reader.read();
      if (done) return buffered.trim() ? JSON.parse(buffered.trim()) : null;
      buffered += decoder.decode(value, { stream: true });
    }
  };
}

async function main() {
  const admin = readAdmin(adminFile);
  if (!admin) {
    note("No admin account given: create one at http://localhost:7777 (the first account becomes the admin).");
    return 0;
  }
  const dataFile = path.join(moonlightDir, "server", "data.json");
  if (existsSync(dataFile)) {
    const data = JSON.parse(readFileSync(dataFile, "utf8"));
    if (Object.keys(data.users ?? {}).length) {
      note("Luma Arcade already has accounts: leaving them and its paired PCs as they are.");
      return 0;
    }
  }

  step("Starting moonlight-web-stream to set up the first account");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}/stream/api`;
  const child = spawn(
    path.join(moonlightDir, process.platform === "win32" ? "web-server.exe" : "web-server"),
    ["--bind-address", `127.0.0.1:${port}`, "--path-prefix", "/stream"],
    { cwd: moonlightDir, stdio: "ignore", windowsHide: true }
  );
  let exited = false;
  child.on("exit", () => (exited = true));

  try {
    for (let i = 0; ; i++) {
      if (exited) throw new Error("moonlight-web-stream stopped straight away");
      try {
        await fetch(`${base}/authenticate`, { signal: AbortSignal.timeout(1000) });
        break;
      } catch {
        if (i > 60) throw new Error("moonlight-web-stream didn't start");
        await sleep(500);
      }
    }

    // The first sign-in creates the account, as an admin.
    let res = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: admin.name, password: admin.password }),
    });
    if (!res.ok) throw new Error(`creating the admin account failed (${res.status})`);
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
    const headers = { "content-type": "application/json", cookie };
    step(`Luma Arcade admin account: ${admin.name}`);

    // This PC's Sunshine. Its service may still be restarting after setup.
    let host = null;
    for (let i = 0; i < 30 && !host; i++) {
      res = await fetch(`${base}/host`, { method: "POST", headers, body: JSON.stringify({ address: "localhost", http_port: 47989 }) });
      if (res.ok) host = (await res.json()).host;
      else await sleep(2000);
    }
    if (!host) throw new Error("Sunshine isn't answering on this PC - pair it later in Luma Arcade (add a PC: localhost)");

    // Every account (not just the admin) can play on it.
    res = await fetch(`${base}/host`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ host_id: host.host_id, change_owner: true, owner: null }),
    });
    if (!res.ok) note(`couldn't share the PC with every account (${res.status}): do it in Luma Arcade's admin page`);
    step(`Pairing with Sunshine on ${host.name ?? "this PC"}`);

    const pairing = new AbortController();
    res = await fetch(`${base}/pair`, { method: "POST", headers, body: JSON.stringify({ host_id: host.host_id }), signal: pairing.signal });
    if (!res.ok || !res.body) throw new Error(`pairing didn't start (${res.status})`);
    const next = lineReader(res.body);
    const first = await next();
    if (!first?.Pin) throw new Error(`pairing didn't start: ${JSON.stringify(first)}`);
    // moonlight shows the PIN before its pairing request has reached
    // Sunshine, and until it has, Sunshine answers {"status":false} (no one
    // waiting for a PIN): keep trying for a while.
    let pin;
    for (let i = 0; i < 40; i++) {
      pin = await sunshine("POST", "/api/pin", admin, { pin: first.Pin, name: "Luma Arcade" });
      if (pin.status !== 200 || !/"status"\s*:\s*false/.test(pin.text)) break;
      await sleep(500);
    }
    if (pin.status === 401) {
      pairing.abort();
      throw new Error("Sunshine already had another sign-in: in Luma Arcade, open the PC \"localhost\" and pair it (the PIN goes in https://localhost:47990 > PIN)");
    }
    if (pin.status !== 200 || /"status"\s*:\s*false/.test(pin.text)) {
      pairing.abort();
      throw new Error(`Sunshine didn't take the PIN (${pin.status} ${pin.text.slice(0, 200)})`);
    }
    const second = await next();
    if (!second?.Paired) throw new Error(`pairing failed: ${JSON.stringify(second)}`);
    step("Paired: this PC's games are ready in Luma Arcade");
    return 0;
  } finally {
    child.kill();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    note(`FAILED: ${err.message}`);
    process.exit(1);
  }
);
