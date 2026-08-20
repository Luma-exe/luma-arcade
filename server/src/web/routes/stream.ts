import type { FastifyInstance } from "fastify";
import { capturePipeline } from "../../capture/gstProcess.js";
import {
  buildFullDesktopPipelineArgs,
  buildWindowCapturePipelineArgs,
} from "../../capture/pipeline.js";
import { getSessionState, setSessionState } from "../../capture/session.js";
import { waitForMainWindow } from "../../capture/windowTracker.js";
import { getSetting } from "../../config/settings.js";
import { setScreenSize } from "../../input/injector.js";
import { getStunTurnConfig } from "../../remote/iceServers.js";
import { requireAuth } from "../session.js";

export async function registerStreamRoutes(app: FastifyInstance, opts: { port: number }) {
  const signallingUri = `ws://127.0.0.1:${opts.port}/signalling`;

  function pipelineOpts() {
    return {
      signallingUri,
      framerate: getSetting("framerate"),
      bitrateKbps: getSetting("bitrateKbps"),
      ...getStunTurnConfig(),
    };
  }

  async function startFullDesktop(): Promise<void> {
    await capturePipeline.stopAndWait();
    capturePipeline.start(buildFullDesktopPipelineArgs(pipelineOpts()));
    setSessionState({ mode: "desktop" });
  }

  app.post<{ Body: { width: number; height: number; gameId?: number; pid?: number } }>(
    "/api/stream/start",
    { preHandler: requireAuth },
    async (request) => {
      const { width, height, gameId, pid } = request.body;
      setScreenSize(width, height);

      const current = getSessionState();
      const alreadyMatchesGame = current.mode === "game" && current.gameId === gameId;
      const alreadyDesktop = current.mode === "desktop" && !gameId;

      if (capturePipeline.isRunning() && (alreadyMatchesGame || alreadyDesktop)) {
        return { ok: true, mode: current.mode, resumed: true };
      }

      if (pid) {
        // Per-game window capture. Falls back to full desktop if the window
        // never appears or the GStreamer build doesn't support window-handle.
        const windowHandle = await waitForMainWindow(pid);
        if (windowHandle) {
          await capturePipeline.stopAndWait();
          capturePipeline.start(
            buildWindowCapturePipelineArgs({ ...pipelineOpts(), windowHandle })
          );
          setSessionState({ mode: "game", gameId, pid, windowHandle });
          return { ok: true, mode: "game" };
        }
        app.log.warn({ pid }, "no main window found for launched process — falling back to full desktop");
      }

      await startFullDesktop();
      if (gameId) setSessionState({ mode: "desktop", gameId });
      return { ok: true, mode: "desktop", fallback: !!pid };
    }
  );

  app.post("/api/stream/switch-to-desktop", { preHandler: requireAuth }, async () => {
    await startFullDesktop();
    return { ok: true };
  });

  app.post("/api/stream/stop", { preHandler: requireAuth }, async () => {
    capturePipeline.stop();
    return { ok: true };
  });

  app.get("/api/stream/status", { preHandler: requireAuth }, async () => ({
    running: capturePipeline.isRunning(),
    ...getSessionState(),
  }));
}
