import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { dataPath } from "../platform.js";

// The server's log on disk. Installed copies run node hidden with the output
// thrown away, so without a file there is nothing to read when something goes
// wrong. The file is capped: past `maxBytes` it becomes server.log.1 (the
// older ones shift to .2 and .3, the oldest is deleted) and a new one starts.

export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_KEEP = 3;
/** How often the size is looked at besides when writing. */
const CHECK_EVERY_MS = 5 * 60_000;

/** The bits of fs rotation uses, so a test can make a rename fail. */
export interface RotateOps {
  renameSync(from: string, to: string): void;
  rmSync(file: string, opts: { force: boolean }): void;
  existsSync(file: string): boolean;
  now(): number;
}
const realOps: RotateOps = { renameSync, rmSync, existsSync, now: () => Date.now() };

/** After a failed rotation (the file is held open elsewhere) it isn't tried again for this long. */
export const ROTATE_RETRY_MS = 60_000;

/** Shifts file.2 -> file.3, file.1 -> file.2, file -> file.1 (the oldest goes).
 * The live file is moved aside first: if that fails (Windows, file held open) it throws
 * and the older files are left exactly as they were. */
export function rotateFiles(file: string, keep = LOG_KEEP, ops: RotateOps = realOps): void {
  const aside = `${file}.rotating`;
  ops.rmSync(aside, { force: true });
  ops.renameSync(file, aside);
  ops.rmSync(`${file}.${keep}`, { force: true });
  for (let i = keep - 1; i >= 1; i--) {
    if (ops.existsSync(`${file}.${i}`)) ops.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
  }
  ops.renameSync(aside, `${file}.1`);
}

/** Rotates `file` if it is bigger than `maxBytes`; true if it did. Not for a file that is open for writing on Windows (use RotatingLog). */
export function rotateIfTooBig(file: string, maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP): boolean {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return false;
  }
  if (size <= maxBytes) return false;
  rotateFiles(file, keep);
  return true;
}

/** Appends text to a size-capped log file. Never throws: a log that can't be
 * written must not take the server down with it. */
export class RotatingLog {
  private fd: number | null = null;
  private size = 0;
  /** Don't try to rotate before this time (a rename just failed). */
  private retryAt = 0;

  constructor(
    readonly file: string,
    private readonly maxBytes = LOG_MAX_BYTES,
    private readonly keep = LOG_KEEP,
    private readonly ops: RotateOps = realOps
  ) {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
    } catch {
      // write() will just fail quietly too
    }
    this.check();
  }

  write(text: string): void {
    try {
      if (this.fd === null) this.open();
      if (this.fd === null) return;
      this.size += writeSync(this.fd, text);
      if (this.size > this.maxBytes) this.check();
    } catch {
      this.close();
    }
  }

  /** Rotates if the file is over the cap. The file is closed first: Windows won't rename an open one. */
  check(): void {
    if (this.ops.now() < this.retryAt) return;
    try {
      let size = this.size;
      try {
        size = statSync(this.file).size;
      } catch {
        size = 0;
      }
      if (size <= this.maxBytes) return;
      this.close();
      try {
        rotateFiles(this.file, this.keep, this.ops);
        this.size = 0;
      } catch {
        // Couldn't move it: keep appending to it and leave it alone for a while.
        this.retryAt = this.ops.now() + ROTATE_RETRY_MS;
      }
    } catch {
      this.close();
    }
  }

  close(): void {
    if (this.fd === null) return;
    try {
      closeSync(this.fd);
    } catch {
      // already closed
    }
    this.fd = null;
  }

  private open(): void {
    this.fd = openSync(this.file, "a");
    try {
      this.size = statSync(this.file).size;
    } catch {
      this.size = 0;
    }
  }
}

/** Where the server log goes. */
export function serverLogPath(): string {
  return dataPath("logs", "server.log");
}

/** What Fastify's logger writes to: the usual stdout plus the rotating file.
 * undefined (just stdout) in tests, or when LUMA_LOG_FILE=off. */
export function createServerLogStream(): { write(line: string): void } | undefined {
  if (process.env.NODE_ENV === "test" || process.env.LUMA_LOG_FILE === "off") return undefined;
  const log = new RotatingLog(serverLogPath());
  // Also looked at now and then, so a quiet-then-busy server is capped promptly.
  setInterval(() => log.check(), CHECK_EVERY_MS).unref();
  return {
    write(line: string) {
      try {
        process.stdout.write(line);
      } catch {
        // stdout can be a closed handle when run hidden
      }
      log.write(line);
    },
  };
}
