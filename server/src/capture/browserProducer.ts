import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The video producer is a hidden Electron window, not a GStreamer pipeline:
// Windows desktop capture via d3d11screencapturesrc + hand-rolled webrtcbin
// hit a wall of narrow, hard-to-reproduce driver/encoder bugs, and plain
// Chromium's `--auto-select-desktop-capture-source` flag (matching a picker
// source by label string) turned out unreliable in testing -- its failure
// mode is a silently hung getDisplayMedia() promise waiting on a picker
// dialog nobody can see or click. Electron's `desktopCapturer` API picks the
// exact source programmatically (see producer-electron/main.js), so there's
// no label-matching guesswork, while still using the browser's own mature
// screen-capture + WebRTC stack against the same signalling server the
// browser consumer already talks to (server/src/signalling/server.ts).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/capture -> dist -> server -> producer-electron
const PRODUCER_ELECTRON_DIR = path.join(__dirname, "..", "..", "producer-electron");

function resolveElectronBinary(): string {
  return path.join(PRODUCER_ELECTRON_DIR, "node_modules", "electron", "dist", "electron.exe");
}

export interface ProducerOptions {
  port: number;
  mode: "desktop" | "window";
  /** Substring matched against Electron's window-source names when mode is
   * "window" (see pickSource in producer-electron/main.js). */
  windowTitle?: string;
  /** Which physical display to capture when mode is "desktop", by index
   * into desktopCapturer's screen-source list. Defaults to 0 (primary). */
  monitorIndex?: number;
}

export function buildProducerArgs(opts: ProducerOptions): string[] {
  const args = [PRODUCER_ELECTRON_DIR, `--port=${opts.port}`, `--mode=${opts.mode}`];
  if (opts.mode === "window" && opts.windowTitle) {
    args.push(`--window-title=${opts.windowTitle}`);
  }
  if (opts.mode === "desktop" && opts.monitorIndex !== undefined) {
    args.push(`--monitor-index=${opts.monitorIndex}`);
  }
  return args;
}

function runPowerShell(command: string): Promise<string> {
  return new Promise((resolve) => {
    const ps = spawn("powershell.exe", ["-NoProfile", "-Command", command]);
    let out = "";
    ps.stdout.on("data", (d) => (out += d.toString()));
    ps.on("close", () => resolve(out.trim()));
    ps.on("error", () => resolve(""));
  });
}

// PowerShell single-quoted strings are already literal — only the quote
// character itself needs escaping (by doubling it), nothing else.
function psLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/** Finds our producer's process(es) by command line, not by tracking the
 * child_process handle we spawned: Electron/Chromium's Windows launcher
 * process can hand off to the real browser process tree and exit almost
 * immediately, which was observed to make the spawned handle report "not
 * running" seconds after a perfectly healthy producer window came up.
 * PRODUCER_ELECTRON_DIR is unique to this app, so matching on it in the
 * command line reliably identifies our window's process(es) among any other
 * electron.exe instances that might exist on the machine. */
async function findProducerPids(): Promise<number[]> {
  const out = await runPowerShell(
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ` +
      `Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${psLiteral(PRODUCER_ELECTRON_DIR)}') } | ` +
      `Select-Object -ExpandProperty ProcessId`
  );
  return out
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** Only the main Electron process's command line lacks `--type=` -- gpu,
 * utility, and renderer helper processes all share the same app path but
 * carry a --type= flag identifying which kind of helper they are. Killing
 * specifically the main process(es) by PID with `taskkill /T` takes their
 * whole child tree with them in one shot, which is what actually makes a
 * *new* invocation start a genuinely fresh Electron process (and therefore
 * re-run desktopCapturer source selection) instead of leaving orphaned
 * helpers around. */
async function findMainProducerPids(): Promise<number[]> {
  const out = await runPowerShell(
    `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ` +
      `Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${psLiteral(PRODUCER_ELECTRON_DIR)}') -and -not $_.CommandLine.Contains('--type=') } | ` +
      `Select-Object -ExpandProperty ProcessId`
  );
  return out
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function taskkillTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => resolve());
  });
}

class BrowserProducerProcess {
  async isRunning(): Promise<boolean> {
    const pids = await findProducerPids();
    return pids.length > 0;
  }

  start(args: string[]): void {
    const binary = resolveElectronBinary();
    const child = spawn(binary, args, { windowsHide: true });
    child.stdout?.on("data", (chunk) => process.stdout.write(`[producer] ${chunk}`));
    child.stderr?.on("data", (chunk) => process.stderr.write(`[producer] ${chunk}`));
    child.on("error", (err) => {
      console.error("[producer] failed to start:", err.message);
    });
    child.unref();
  }

  async stop(): Promise<void> {
    const mainPids = await findMainProducerPids();
    await Promise.all(mainPids.map(taskkillTree));
  }

  async stopAndWait(): Promise<void> {
    await this.stop();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!(await this.isRunning())) return;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

export const producerProcess = new BrowserProducerProcess();
