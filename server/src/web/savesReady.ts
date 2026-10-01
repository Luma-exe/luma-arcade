import { readFileSync } from "node:fs";
import { closeRunningGame } from "./idle.js";
import { MAIN, savesElsewhere } from "./saveSync.js";
import { decide, gameEnded } from "./sessions.js";
import { sunshineAppName } from "./sunshine.js";
import type { StreamUser } from "./streamUser.js";

// Per-player saves (host/profiles.ps1) are swapped by Sunshine's prep-cmd,
// which only runs when Sunshine STARTS the ES-DE app. A stream into an
// ES-DE that's already running (someone else's session, left open or taken
// over) resumes it, so the new player used to play on the last player's
// saves. The stream page asks here first: if ES-DE is running with someone
// else's saves in, that session is closed and Sunshine starts it fresh -
// with this player's saves - when they connect.

export const PROFILES_STATE = process.env.LUMA_PROFILES_STATE || "C:\ProgramData\LumaArcade\profiles\state.json";
const SERVERINFO = "http://127.0.0.1:47989/serverinfo";
const FREE_WAIT_MS = 15_000;
const FREE_POLL_MS = 500;

/** Whose saves are in the emulators' folders now ("user-<id>"), if known. */
export function savesLoadedFor(file = PROFILES_STATE): string | null {
  try {
    const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    return (JSON.parse(text) as { current?: string | null }).current ?? null;
  } catch {
    return null;
  }
}

/** Only the ES-DE app swaps saves (Steam and the desktop keep their own). */
export function swapsSaves(appName: string | null): boolean {
  return !!appName && /es-?de/i.test(appName);
}

export async function sunshineRunningApp(): Promise<{ busy: boolean; appId: number | null }> {
  const text = await (await fetch(SERVERINFO, { signal: AbortSignal.timeout(3000) })).text();
  const id = Number(/<currentgame>(\d+)<\/currentgame>/.exec(text)?.[1] ?? 0);
  return { busy: /<state>SUNSHINE_SERVER_BUSY<\/state>/.test(text), appId: id > 0 ? id : null };
}

export interface ReadyDeps {
  running: () => Promise<{ busy: boolean; appId: number | null }>;
  loadedFor: () => string | null;
  appName: (appId: number) => Promise<string | null>;
  close: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
}

const realDeps: ReadyDeps = {
  running: sunshineRunningApp,
  loadedFor: () => savesLoadedFor(),
  appName: sunshineAppName,
  close: closeRunningGame,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

let inFlight: Promise<{ restarted: boolean }> | null = null;

/** Before `user` streams: make sure the saves they'll get are theirs.
 * restarted = the running session (with someone else's saves) was closed. */
export async function prepareSaves(user: StreamUser, deps: ReadyDeps = realDeps): Promise<{ restarted: boolean } | { error: string }> {
  const decision = decide(user);
  if (!decision.allowed) return { error: decision.reason ?? "The PC is in use." };
  // Player 2 plays on the player's game (and saves).
  if (decision.guest) return { restarted: false };
  inFlight ??= (async () => {
    try {
      const running = await deps.running().catch(() => ({ busy: false, appId: null }));
      if (!running.busy || running.appId === null) return { restarted: false };
      if (!swapsSaves(await deps.appName(running.appId).catch(() => null))) return { restarted: false };
      const loaded = deps.loadedFor();
      // Theirs are loaded and nothing newer is on another PC (saveSync.ts).
      if (loaded === `user-${user.id}` && !savesElsewhere(user.id, MAIN)) return { restarted: false };
      if (!(await deps.close())) return { restarted: false };
      gameEnded();
      // Sunshine takes a moment to close ES-DE; connecting before that
      // would resume the old session after all.
      for (let waited = 0; waited < FREE_WAIT_MS; waited += FREE_POLL_MS) {
        const now = await deps.running().catch(() => ({ busy: true, appId: null }));
        if (!now.busy) break;
        await deps.sleep(FREE_POLL_MS);
      }
      return { restarted: true };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
