import type { FastifyInstance } from "fastify";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { requireAuth } from "../session.js";
import { getActiveInput } from "./input.js";

const run = promisify(execFile);

// home.ps1 (moonlight-web-stream's host/home.ps1) runs on the Arcade desktop
// through this scheduled task, since this service lives in session 0 and
// can't see or move the stream's windows. It reads the request file and
// answers with result-<id>.json next to it.
export const HOME_TASK = "\\LumaArcade\\Home";
export const HOME_SCRIPT = "C:\\ProgramData\\LumaArcade\\home.ps1";
const HOME_DIR = "C:\\ProgramData\\LumaArcade\\home";

type Launcher = "es-de" | "steam";

export interface HomeQueryResult {
  ok: boolean;
  error?: string;
  launcher?: string;
  onLauncher?: boolean;
  game?: {
    hwnd: number;
    title: string;
    process: string;
    /** the exe's description, e.g. "Xenia Canary" */
    app?: string;
    /** PNG data URL of the app's icon */
    icon?: string | null;
    /** the game's name from its ROM or Steam folder, when it's that window */
    name?: string;
    /** ES-DE system name ("xbox360", "wii"...) or "pc" */
    system?: string | null;
  } | null;
}

export interface HomeGoResult {
  ok: boolean;
  error?: string;
  launcher?: string;
  closed?: boolean;
  forced?: boolean;
  launched?: boolean;
}

// One request file, so one request at a time.
let queue: Promise<unknown> = Promise.resolve();

function runHome<T>(request: Record<string, unknown>, timeoutMs: number): Promise<T> {
  const job = queue.then(async () => {
    const id = randomUUID();
    const resultPath = path.join(HOME_DIR, `result-${id}.json`);
    await writeFile(path.join(HOME_DIR, "request.json"), JSON.stringify({ id, ...request }));
    try {
      await run("schtasks.exe", ["/run", "/tn", HOME_TASK], { windowsHide: true, timeout: 5000 });
    } catch {
      throw new Error("The host's Home helper isn't set up (scheduled task LumaArcade\\Home)");
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      if (!existsSync(resultPath)) continue;
      try {
        const text = (await readFile(resultPath, "utf8")).replace(/^\uFEFF/, "");
        const result = JSON.parse(text) as T;
        // Written as the Arcade user, readable and deletable by admins.
        await rm(resultPath, { force: true }).catch(() => {});
        return result;
      } catch {
        // caught it mid-write; try again
      }
    }
    throw new Error("The host didn't answer in time");
  });
  queue = job.catch(() => {});
  return job;
}

export interface HostWindow {
  hwnd: number;
  title: string;
  process: string;
  foreground: boolean;
  minimized: boolean;
  /** PNG data URL of the app's icon, when it could be read */
  icon: string | null;
}

function launcherParam(value: unknown): Launcher | "" {
  return value === "es-de" || value === "steam" ? value : "";
}

/** The stream page's Home button: go back to ES-DE or Steam Big Picture,
 * keeping or closing the window that was in front. */
export async function registerHomeRoutes(app: FastifyInstance) {
  // What's in front right now, so the page can ask about it by name.
  app.post<{ Body: { launcher?: string } }>(
    "/api/home/query",
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        // What's running (ROM path / Steam folder) knows the game's real
        // name; the window title is often an emulator's version string.
        const [result, active] = await Promise.all([
          runHome<HomeQueryResult>({ action: "query", launcher: launcherParam(req.body?.launcher) }, 10_000),
          getActiveInput().catch(() => null),
        ]);
        const game = result.game;
        if (game && active?.title && active.process?.toLowerCase() === `${game.process}.exe`.toLowerCase()) {
          game.name = active.title;
          game.system = active.system;
        }
        return result;
      } catch (err) {
        return reply.code(503).send({ ok: false, error: (err as Error).message });
      }
    }
  );

  // The stream's window picker (hold Alt+Tab): the desktop's app windows,
  // and switching to one of them.
  app.post("/api/windows", { preHandler: requireAuth }, async (_req, reply) => {
    try {
      return await runHome<{ ok: boolean; error?: string; windows?: HostWindow[] }>({ action: "windows" }, 12_000);
    } catch (err) {
      return reply.code(503).send({ ok: false, error: (err as Error).message });
    }
  });

  app.post<{ Body: { hwnd?: number } }>(
    "/api/windows/focus",
    { preHandler: requireAuth },
    async (req, reply) => {
      const hwnd = Number(req.body?.hwnd);
      if (!Number.isSafeInteger(hwnd) || hwnd <= 0) {
        return reply.code(400).send({ ok: false, error: "No window given" });
      }
      try {
        return await runHome<{ ok: boolean; error?: string }>({ action: "focus", hwnd }, 10_000);
      } catch (err) {
        return reply.code(503).send({ ok: false, error: (err as Error).message });
      }
    }
  );

  app.post<{ Body: { launcher?: string; close?: boolean; hwnd?: number } }>(
    "/api/home/go",
    { preHandler: requireAuth },
    async (req, reply) => {
      const hwnd = Number(req.body?.hwnd);
      try {
        // Closing waits up to 6s for the game, and starting a launcher that
        // wasn't running can take a while.
        return await runHome<HomeGoResult>(
          {
            action: "go",
            launcher: launcherParam(req.body?.launcher),
            close: req.body?.close === true,
            hwnd: Number.isSafeInteger(hwnd) && hwnd > 0 ? hwnd : null,
          },
          75_000
        );
      } catch (err) {
        return reply.code(503).send({ ok: false, error: (err as Error).message });
      }
    }
  );
}
