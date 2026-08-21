import { spawn } from "node:child_process";

/** An unhandled 'error' event on a ChildProcess (bad exe path, missing
 * binary, etc.) crashes the whole server — this must never throw. */
export function spawnDetached(command: string, args: string[]) {
  const child = spawn(command, args, { detached: true });
  child.on("error", (err) => {
    console.error(`[launch] failed to start "${command}":`, err.message);
  });
  child.unref();
  return child;
}
