import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { checkUpdates, jobStatus, listInstalled, startUpdate, updatesKey, type Mode } from "../../updates/index.js";
import { isLocalRequest } from "../requestOrigin.js";
import { requireAdmin } from "../streamUser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(__dirname, "..", "pages", "updates.html");
let page: string | null = null;

const ID = /^[a-z0-9-]{1,32}$/;
const CHECK_WAIT_MS = 20_000;

function sameKey(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(updatesKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A signed-in admin (Settings, Server & updates: also over the internet,
 * like Apply update), or the tray window's key from this PC / home network. */
async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = request.headers["x-updates-key"];
  if (typeof key === "string" && key) {
    if (!isLocalRequest(request)) {
      reply.code(403).send({ error: "The tray window only works from this PC or the home network" });
      return;
    }
    if (sameKey(key)) return;
  }
  await requireAdmin(request, reply);
}

function modeOf(v: unknown): Mode {
  return v === "newest" ? "newest" : "tested";
}

export async function registerUpdatesRoutes(app: FastifyInstance) {
  app.get("/updates", async (_request, reply) => reply.redirect("/updates/"));
  app.get("/updates/", async (_request, reply) => {
    page ??= readFileSync(PAGE, "utf-8");
    reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(page);
  });

  app.get("/api/updates", { preHandler: guard }, async (request) => {
    const q = request.query as { mode?: string };
    return listInstalled(modeOf(q.mode));
  });

  app.post("/api/updates/check", { preHandler: guard }, async (request, reply) => {
    const body = (request.body ?? {}) as { mode?: string; ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === "string" && ID.test(i)) : undefined;
    const mode = modeOf(body.mode);
    const run = checkUpdates(mode, ids?.length ? ids : undefined);
    run.catch(() => {});
    // Cloudflare drops a request after 100 s, and a full check can take
    // longer: past 20 s, answer "still checking" and let the page ask again.
    const done = await Promise.race([run.then((l) => l, (e: Error) => e), new Promise<null>((r) => setTimeout(() => r(null), CHECK_WAIT_MS))]);
    if (done instanceof Error) {
      reply.code(502).send({ error: done.message });
      return;
    }
    return done ?? { ...(await listInstalled(mode)), checking: true };
  });

  app.post("/api/updates/apply", { preHandler: guard }, async (request, reply) => {
    const body = (request.body ?? {}) as { mode?: string; ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === "string" && ID.test(i)) : [];
    if (!ids.length) {
      reply.code(400).send({ error: "Pick something to update" });
      return;
    }
    try {
      return startUpdate([...new Set(ids)], modeOf(body.mode));
    } catch (err) {
      reply.code(409).send({ error: (err as Error).message });
    }
  });

  app.get("/api/updates/job", { preHandler: guard }, async () => jobStatus());
}
