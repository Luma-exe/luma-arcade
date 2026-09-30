import type { FastifyBaseLogger } from "fastify";
import { notify } from "./notify.js";
import { awayCheck, disconnectEveryone, gameEnded } from "./sessions.js";
import { sunshineGet } from "./sunshine.js";

// Nothing left running for nobody: every CHECK_MS, players away from their
// controls too long are disconnected, and a game nobody has streamed for a
// while is closed on the PC (sessions.ts awayCheck decides both).

const CHECK_MS = 30_000;

/** Closes whatever Sunshine is running (Moonlight's "quit app"). */
export async function closeRunningGame(): Promise<boolean> {
  const answer = await sunshineGet("/cancel", 10_000);
  return answer.status === "ok" && answer.code === 200 && !/status_code="[45]\d\d"/.test(answer.body);
}

/** One check. Returns what it did, for the log and tests. */
export async function idleTick(
  close: () => Promise<boolean> = closeRunningGame,
  now = Date.now()
): Promise<{ kicked: string[]; closed: boolean }> {
  const { kicked, endGame } = awayCheck(now);
  let closed = false;
  if (endGame && (await close())) {
    gameEnded();
    closed = true;
  }
  return { kicked: kicked.map((u) => u.name), closed };
}

/** An admin's "Force stop": every stream ends and the game is closed. */
export async function forceStop(adminName: string, close: () => Promise<boolean> = closeRunningGame): Promise<{ disconnected: number; closed: boolean }> {
  const disconnected = disconnectEveryone(`${adminName} ended the session`);
  const closed = await close();
  if (closed) gameEnded();
  return { disconnected, closed };
}

let timer: NodeJS.Timeout | null = null;
let failedClose = false;

export function startIdleChecks(log: FastifyBaseLogger): void {
  if (timer) return;
  timer = setInterval(() => {
    void idleTick()
      .then(({ kicked, closed }) => {
        for (const name of kicked) {
          log.info({ player: name }, "disconnected for being away");
          void notify(`💤 ${name} was away from the controls, so their stream was ended`);
        }
        if (closed) {
          failedClose = false;
          log.info("closed the game nobody was streaming");
        }
      })
      .catch((err: Error) => {
        if (!failedClose) log.warn({ err }, "idle check failed");
        failedClose = true;
      });
  }, CHECK_MS);
  timer.unref();
}
