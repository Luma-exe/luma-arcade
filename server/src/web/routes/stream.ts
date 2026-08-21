import type { FastifyInstance } from "fastify";
import { buildProducerArgs, producerProcess } from "../../capture/browserProducer.js";
import { listDisplays } from "../../capture/displays.js";
import { getSessionState, setSessionState } from "../../capture/session.js";
import { waitForMainWindow } from "../../capture/windowTracker.js";
import { setScreenSize } from "../../input/injector.js";
import { isProducerRegistered } from "../../signalling/server.js";
import { requireAuth } from "../session.js";

/** Spawning the producer window doesn't mean it's ready — it still has to
 * load, acquire its capture source, and connect to the signalling server,
 * which observably takes a second or two. Responding to /api/stream/start
 * before that finishes races the browser's consumer connection against a
 * producer that doesn't exist yet, surfacing as "no such producer". */
async function waitForProducerReady(timeoutMs = 30000): Promise<boolean> {
  const start = Date.now();
  // Unlike the old GStreamer child-process handle, "is it running" here is
  // an async Win32_Process lookup by command line -- it takes Electron a
  // real moment to actually start and become visible to that query, so
  // bailing on the very first (near-instant) empty result treated a normal
  // startup delay as a crash. Only trust "not running" as fatal after
  // giving the browser a few seconds to actually come up.
  const startupGraceMs = 3000;
  while (Date.now() - start < timeoutMs) {
    if (isProducerRegistered()) return true;
    if (Date.now() - start > startupGraceMs && !(await producerProcess.isRunning())) {
      return false; // producer window died — no point waiting further
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return isProducerRegistered();
}

async function startCapture(
  port: number,
  args: { mode: "desktop"; monitorIndex?: number } | { mode: "window"; windowTitle: string }
): Promise<void> {
  await producerProcess.stopAndWait();
  producerProcess.start(buildProducerArgs({ port, ...args }));
}

async function startFullDesktop(port: number, monitorIndex?: number): Promise<void> {
  await startCapture(port, { mode: "desktop", monitorIndex });
  setSessionState({ mode: "desktop", monitorIndex });
}

/** Re-spawns the producer for whatever was already being captured, without
 * waiting for a client to notice and ask for it. An RDP connect/disconnect
 * swaps out the console session's actual rendering target and leaves the
 * existing capture handle frozen on whatever it last saw -- killing the
 * producer (see onRdpChange in main.ts) fixes that, but without this a dead
 * producer just stays dead until some browser tab happens to be open and
 * polling /api/rdp-status at the right moment to trigger a normal /api/
 * stream/start call. Restarting proactively here means the stream recovers
 * on its own even if nobody's tab was open to notice. */
export async function restartCaptureForCurrentSession(port: number): Promise<void> {
  const current = getSessionState();
  if (current.mode === "game" && current.pid && current.windowTitle) {
    await startCapture(port, { mode: "window", windowTitle: current.windowTitle });
  } else {
    await startFullDesktop(port, current.monitorIndex);
  }
}

export async function registerStreamRoutes(app: FastifyInstance, opts: { port: number }) {
  app.get("/api/displays", { preHandler: requireAuth }, async () => ({
    displays: await listDisplays(),
  }));

  app.post<{
    Body: { width: number; height: number; gameId?: number; pid?: number; monitorIndex?: number };
  }>("/api/stream/start", { preHandler: requireAuth }, async (request) => {
    const { width, height, gameId, pid, monitorIndex } = request.body;
    setScreenSize(width, height);

    const current = getSessionState();
    // Comparing gameId alone let ES-DE mode (which only ever sends `pid`,
    // never `gameId`) get permanently stuck: once any request fell back
    // to desktop capture, every later request — even ones carrying a
    // valid pid for window capture — matched `!gameId` and short-
    // circuited back to the stale desktop pipeline without ever
    // retrying window-handle capture.
    const alreadyMatchesGame =
      current.mode === "game" && current.gameId === gameId && current.pid === pid;
    const alreadyDesktop =
      current.mode === "desktop" &&
      !gameId &&
      !pid &&
      (current.monitorIndex ?? 0) === (monitorIndex ?? 0);

    // Trusting pid/mode matching alone here — without confirming the
    // producer is actually registered — let a dead-but-still-running
    // producer window (process alive but stuck before ever reaching
    // signalling registration) get "resumed" forever: every request
    // after that point returned ok:true in ~200ms without a real
    // restart, and the browser saw "no such producer" indefinitely.
    // Only take the fast path when there's an actual producer to
    // resume to.
    if (
      (alreadyMatchesGame || alreadyDesktop) &&
      isProducerRegistered() &&
      (await producerProcess.isRunning())
    ) {
      return { ok: true, mode: current.mode, resumed: true };
    }

    if (pid) {
      // Per-game window capture. Falls back to full desktop if the
      // window never appears (or never gets a title the producer's
      // window-source matching can use).
      const mainWindow = await waitForMainWindow(pid);
      if (mainWindow) {
        await startCapture(opts.port, { mode: "window", windowTitle: mainWindow.title });
        setSessionState({ mode: "game", gameId, pid, windowTitle: mainWindow.title });
        const ready = await waitForProducerReady();
        return { ok: true, mode: "game", producerReady: ready };
      }
      app.log.warn({ pid }, "no main window found for launched process — falling back to full desktop");
    }

    await startFullDesktop(opts.port, monitorIndex);
    if (gameId) setSessionState({ mode: "desktop", gameId, monitorIndex });
    const ready = await waitForProducerReady();
    return { ok: true, mode: "desktop", fallback: !!pid, producerReady: ready };
  });

  app.post<{ Body: { monitorIndex?: number } }>(
    "/api/stream/switch-to-desktop",
    { preHandler: requireAuth },
    async (request) => {
      await startFullDesktop(opts.port, request.body?.monitorIndex);
      const ready = await waitForProducerReady();
      return { ok: true, producerReady: ready };
    }
  );

  app.post("/api/stream/stop", { preHandler: requireAuth }, async () => {
    await producerProcess.stop();
    return { ok: true };
  });

  app.get("/api/stream/status", { preHandler: requireAuth }, async () => ({
    running: await producerProcess.isRunning(),
    ...getSessionState(),
  }));
}
