import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** Generic spawn/log/stop wrapper reused for every long-lived child process
 * this app manages (currently just moonlight-web-stream). */
export class ManagedProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | undefined;
  private crashCount = 0;
  private lastArgs: string[] = [];
  private lastError: string | undefined;

  /** `binary` may be a fixed command name (resolved via PATH at spawn time,
   * same as before) or a function returning one — useful when the real
   * install location needs to be probed at spawn time rather than baked in
   * at construction, e.g. because PATH changes made by an installer don't
   * reliably propagate to already-running processes on Windows. */
  constructor(
    private readonly binary: string | (() => string),
    private readonly logTag: string
  ) {}

  isRunning(): boolean {
    return !!this.child && this.child.exitCode === null;
  }

  /** Surfaced by status endpoints so the UI can explain *why* a process
   * isn't running instead of just showing a blank "not running" state. */
  getLastError(): string | undefined {
    return this.lastError;
  }

  start(args: string[]): void {
    if (this.isRunning()) return;
    this.stopping = false;
    this.lastArgs = args;
    clearTimeout(this.restartTimer);

    const resolvedBinary = typeof this.binary === "function" ? this.binary() : this.binary;
    this.child = spawn(resolvedBinary, args, { windowsHide: true });

    this.child.stdout.on("data", (chunk) => {
      process.stdout.write(`[${this.logTag}] ${chunk}`);
    });
    this.child.stderr.on("data", (chunk) => {
      process.stderr.write(`[${this.logTag}] ${chunk}`);
    });

    // An unhandled 'error' event on a ChildProcess (e.g. ENOENT — the binary
    // isn't installed/on PATH) crashes the entire Node process, taking the
    // whole app down with it. This is the expected case until
    // moonlight-web-stream is actually configured, so it must degrade to a
    // logged failure, not a server crash.
    this.child.on("error", (err) => {
      console.error(`[${this.logTag}] failed to start:`, err.message);
      this.lastError = err.message;
      this.child = undefined;
    });

    this.child.on("exit", (code, signal) => {
      console.log(`[${this.logTag}] exited (code=${code}, signal=${signal})`);
      this.child = undefined;
      if (!this.stopping && code !== 0) {
        this.lastError = `exited with code ${code}`;
        this.scheduleRestart();
      } else if (!this.stopping) {
        // Clean exit (code 0) while we didn't ask for it — still worth a
        // restart, since these processes are meant to be long-lived.
        this.scheduleRestart();
      }
    });
  }

  /** Capped exponential backoff (5s, 10s, 20s ... up to 2min) instead of the
   * previous behavior of just giving up after one crash — a transient issue
   * (host not logged in yet, port briefly held by the previous instance
   * during a restart) used to mean the process stayed down until someone
   * noticed and restarted LumaArcade itself. Resets the backoff once a
   * restart has stayed up for a while, so a process that crash-loops
   * forever doesn't retry instantly forever either. */
  private scheduleRestart(): void {
    this.crashCount++;
    const delayMs = Math.min(5000 * 2 ** (this.crashCount - 1), 120_000);
    console.error(
      `[${this.logTag}] crashed (attempt ${this.crashCount}) — retrying in ${delayMs / 1000}s`
    );
    this.restartTimer = setTimeout(() => {
      if (!this.stopping) this.start(this.lastArgs);
    }, delayMs);

    // A process that's been crash-looping gets its backoff reset once it
    // manages to stay up for a full minute, so a one-off blip doesn't leave
    // it retrying slowly forever afterward.
    setTimeout(() => {
      if (this.isRunning()) this.crashCount = 0;
    }, 60_000);
  }

  stop(): void {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    if (!this.child) return;
    // Windows has no real POSIX signals — Node maps any kill() signal to
    // TerminateProcess. Fine for these processes; none write files that need
    // a graceful flush on shutdown.
    this.child.kill();
  }

  stopAndWait(): Promise<void> {
    if (!this.child) {
      this.stopping = true;
      clearTimeout(this.restartTimer);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.child!.once("exit", () => resolve());
      this.stop();
    });
  }
}
