import { randomBytes, createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ManagedProcess } from "../process/managedProcess.js";
import { getSetting, setSetting } from "../config/settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONF_PATH = path.join(__dirname, "..", "..", "turnserver.generated.conf");

export const coturnProcess = new ManagedProcess("turnserver", "coturn");

function ensureSharedSecret(): string {
  let secret = getSetting("turnSharedSecret");
  if (!secret) {
    secret = randomBytes(24).toString("hex");
    setSetting("turnSharedSecret", secret);
  }
  return secret;
}

function writeTurnConfig(): void {
  const secret = ensureSharedSecret();
  const conf = [
    `listening-port=${getSetting("turnPort")}`,
    "fingerprint",
    "use-auth-secret",
    `static-auth-secret=${secret}`,
    `realm=${getSetting("turnRealm")}`,
    "no-cli",
    "no-tls",
    "no-dtls",
  ].join("\n");
  writeFileSync(CONF_PATH, conf, "utf-8");
}

export function syncCoturnWithSettings(): void {
  const wanted = getSetting("remoteAccessEnabled") && getSetting("turnServerEnabled");
  const binaryPath = getSetting("turnServerBinaryPath");

  if (wanted && binaryPath) {
    if (!coturnProcess.isRunning()) {
      writeTurnConfig();
      coturnProcess.start(["-c", CONF_PATH]);
    }
  } else {
    coturnProcess.stop();
  }
}

/**
 * TURN REST API (time-limited) credential, matching coturn's
 * use-auth-secret scheme: username is "<expiry-unix-ts>", password is
 * base64(HMAC-SHA1(secret, username)).
 */
export function generateTurnCredential(): { username: string; credential: string } {
  const secret = getSetting("turnSharedSecret");
  const ttlSeconds = 3600;
  const username = String(Math.floor(Date.now() / 1000) + ttlSeconds);
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return { username, credential };
}
