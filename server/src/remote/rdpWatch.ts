import { execFile } from "node:child_process";
import { promoteToConsoleSessionIfNeeded } from "./consoleSession.js";

/**
 * Polls for an active inbound Remote Desktop connection (an ESTABLISHED TCP
 * connection on the RDP port) rather than trying to infer it from session
 * naming — `tscon`'d sessions and RDP's own display negotiation can behave
 * inconsistently, but "is something actually connected to port 3389 right
 * now" is unambiguous.
 *
 * Why this matters here: RDP briefly takes over as the rendering target
 * while connected, which can disturb an in-progress capture even with the
 * virtual display driver installed. Rather than guess whether that
 * happened, this flags it to the UI so the user knows *why* streaming
 * might be rough right now, and re-applies the console-session promotion
 * the moment RDP disconnects so nothing has to be done by hand.
 */
const RDP_PORT = `:${3389}`;
const POLL_INTERVAL_MS = 4000;
// Require the new state to hold for this many consecutive polls before
// acting on it — a single netstat snapshot can catch a connection
// mid-handshake or mid-teardown, and reacting to that one blip is what was
// flipping the banner and force-reconnecting the stream every few seconds.
const DEBOUNCE_POLLS = 3;

let rdpConnected = false;
let pendingState = false;
let pendingCount = 0;
const listeners: Array<(connected: boolean) => void> = [];

export function isRdpConnected(): boolean {
  return rdpConnected;
}

export function onRdpChange(fn: (connected: boolean) => void): void {
  listeners.push(fn);
}

/** `netstat -an` line format: "  TCP    0.0.0.0:3389    0.0.0.0:0    LISTENING".
 * A plain substring check for ":3389" also matches unrelated ports that
 * merely contain that sequence (":33890", ":13389", ...) — parse columns
 * instead so only an actual established connection on the local RDP port
 * counts. */
function lineIsEstablishedRdpConnection(line: string): boolean {
  const cols = line.trim().split(/\s+/);
  if (cols[0] !== "TCP") return false;
  const [, localAddr, , state] = cols;
  return !!localAddr && localAddr.endsWith(RDP_PORT) && state === "ESTABLISHED";
}

function checkOnce(): void {
  execFile("netstat", ["-an"], (err, stdout) => {
    if (err) return;
    const nowConnected = stdout.split("\n").some(lineIsEstablishedRdpConnection);

    if (nowConnected === rdpConnected) {
      pendingCount = 0;
      return;
    }

    if (nowConnected === pendingState) {
      pendingCount++;
    } else {
      pendingState = nowConnected;
      pendingCount = 1;
    }
    if (pendingCount < DEBOUNCE_POLLS) return;

    rdpConnected = nowConnected;
    pendingCount = 0;

    if (rdpConnected) {
      console.log("[rdp] Remote Desktop connection detected");
    } else {
      console.log("[rdp] Remote Desktop disconnected — re-applying display fix");
      promoteToConsoleSessionIfNeeded();
    }

    for (const fn of listeners) fn(rdpConnected);
  });
}

export function startRdpWatch(): void {
  if (process.platform !== "win32") return;
  checkOnce();
  setInterval(checkOnce, POLL_INTERVAL_MS);
}
