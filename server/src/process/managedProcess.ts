import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** Generic spawn/log/stop wrapper reused for every long-lived child process
 * this app manages (currently just moonlight-web-stream). */
export class ManagedProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stopping = false;
  // If start() is called while a previous process is still in the middle of
  // exiting (stop() was called but the 'exit' event hasn't landed yet),
  // isRunning() still reports true — the OS process is genuinely still
  // alive. Without this queue, that start() would silently no-op (thinking
  // nothing needs to happen) and then the eventual 'exit' handler would
  // just clear this.child with nothing to bring it back, leaving the
  // process down until some *other* caller happens to invoke start() again.
  // This showed up in practice as syncMoonlightWithSettings() firing twice
  // in quick succession (e.g. two settings saves) leaving
  // moonlight-web-stream stopped.
  private pendingStart: { args: string[]; opts?: { cwd?: string } } | undefined;

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

  start(args: string[], opts?: { cwd?: string }): void {
    if (this.stopping) {
      // A previous stop() is still in flight — remember what to start once
      // its 'exit' handler runs, rather than starting a second process
      // alongside the one that's still dying or silently no-oping.
      this.pendingStart = { args, opts };
      return;
    }
    if (this.isRunning()) return;

    const resolvedBinary = typeof this.binary === "function" ? this.binary() : this.binary;
    this.child = spawn(resolvedBinary, args, { windowsHide: true, cwd: opts?.cwd });

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
      this.child = undefined;
    });

    this.child.on("exit", (code, signal) => {
      console.log(`[${this.logTag}] exited (code=${code}, signal=${signal})`);
      this.child = undefined;
      const wasStopping = this.stopping;
      this.stopping = false;
      if (!wasStopping && code !== 0) {
        console.error(`[${this.logTag}] crashed — not auto-restarting`);
      }
      if (this.pendingStart) {
        const { args, opts } = this.pendingStart;
        this.pendingStart = undefined;
        this.start(args, opts);
      }
    });
  }

  stop(): void {
    this.pendingStart = undefined;
    if (!this.child) return;
    this.stopping = true;
    // Windows has no real POSIX signals — Node maps any kill() signal to
    // TerminateProcess. Fine for these processes; none write files that need
    // a graceful flush on shutdown.
    this.child.kill();
  }

  stopAndWait(): Promise<void> {
    if (!this.child) return Promise.resolve();
    return new Promise((resolve) => {
      this.child!.once("exit", () => resolve());
      this.stop();
    });
  }
}
