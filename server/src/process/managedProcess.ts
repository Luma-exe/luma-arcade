import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** Generic spawn/log/stop wrapper reused for every long-lived child process
 * this app manages (GStreamer, cloudflared, coturn). */
export class ManagedProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stopping = false;

  constructor(private readonly binary: string, private readonly logTag: string) {}

  isRunning(): boolean {
    return !!this.child && this.child.exitCode === null;
  }

  start(args: string[]): void {
    if (this.isRunning()) return;
    this.stopping = false;

    this.child = spawn(this.binary, args, { windowsHide: true });

    this.child.stdout.on("data", (chunk) => {
      process.stdout.write(`[${this.logTag}] ${chunk}`);
    });
    this.child.stderr.on("data", (chunk) => {
      process.stderr.write(`[${this.logTag}] ${chunk}`);
    });

    // An unhandled 'error' event on a ChildProcess (e.g. ENOENT — the binary
    // isn't installed/on PATH) crashes the entire Node process, taking the
    // whole app down with it. This is the expected case until GStreamer/
    // cloudflared/coturn are actually installed, so it must degrade to a
    // logged failure, not a server crash.
    this.child.on("error", (err) => {
      console.error(`[${this.logTag}] failed to start:`, err.message);
      this.child = undefined;
    });

    this.child.on("exit", (code, signal) => {
      console.log(`[${this.logTag}] exited (code=${code}, signal=${signal})`);
      this.child = undefined;
      if (!this.stopping && code !== 0) {
        console.error(`[${this.logTag}] crashed — not auto-restarting`);
      }
    });
  }

  stop(): void {
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
