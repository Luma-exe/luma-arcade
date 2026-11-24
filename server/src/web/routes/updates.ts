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

function sameKey(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(updatesKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Home network only; and the tray window's key, or a signed-in admin. */
async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!isLocalRequest(request)) {
    reply.code(403).send({ error: "Updates only work from this PC or the home network" });
    return;
  }
  const key = request.headers["x-updates-key"];
  if (typeof key === "string" && sameKey(key)) return;
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
    try {
      return await checkUpdates(modeOf(body.mode), ids?.length ? ids : undefined);
    } catch (err) {
      reply.code(502).send({ error: (err as Error).message });
    }
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
