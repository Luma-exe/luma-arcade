import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../../db/index.js";
import { MOONLIGHT_PATH_PREFIX } from "../../remote/moonlightWebStream.js";
import { notify } from "../notify.js";
import { clientIp } from "../requestOrigin.js";
import { requireAdmin, streamUser } from "../streamUser.js";

// arcade.lumaplayground.com's front page: what this is, Sign in, and for
// people without an account, "Request an account" - which pings the admin
// on Discord (settings: discordWebhookUrl) with their name, Discord and
// message. One request per visitor address, and a cap on all of them so
// nobody can use it to spam the admin.
//
// The sign-in cookie only exists under /stream, so the page itself asks
// /stream/luma-api/me whether you're signed in and goes straight on if so.

/** Who gets pinged for account requests. */
export const ADMIN_DISCORD_ID = "851332798231871508";
/** At most this many requests from everyone together per hour. */
const REQUESTS_PER_HOUR = 10;
const MAX_NAME = 40;
const MAX_CONTACT = 40;
const MAX_MESSAGE = 500;
/** One password reset request per visitor per this long. */
const RESET_EVERY_MS = 24 * 60 * 60_000;

const PAGES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "pages");
const PAGE = path.join(PAGES, "welcome.html");
let page: string | null = null;
/** /howitworks/: how the arcade works and everything it does, for visitors. */
const HOW_PAGE = path.join(PAGES, "howitworks.html");
let howPage: string | null = null;

/** One line of text as typed, trimmed to `max`. */
export function oneLine(value: unknown, max: number): string {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

/** Text for the Discord post: formatting characters shown as typed
 * (luma_exe stays luma_exe) and no pings. */
export function forDiscord(text: string): string {
  return text.replace(/[*_~`|>\\]/g, "\\$&").replace(/@/g, "@\u200b");
}

/** The message as a Discord quote (blank lines squeezed). */
function quote(message: string): string {
  return message
    .replace(/\r/g, "")
    .split("\n")
    .filter((l, i, all) => l.trim() || (i > 0 && all[i - 1].trim()))
    .map((l) => `> ${forDiscord(l)}`)
    .join("\n");
}

export async function registerWelcomeRoutes(app: FastifyInstance) {
  app.get("/", async (request, reply) => {
    // Links with a query (the tray's /?view=settings) go to the arcade itself.
    const query = request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : "";
    if (query) return reply.redirect(`${MOONLIGHT_PATH_PREFIX}/${query}`);
    try {
      page ??= readFileSync(PAGE, "utf8");
    } catch {
      return reply.redirect(`${MOONLIGHT_PATH_PREFIX}/`);
    }
    return reply.header("cache-control", "no-cache").type("text/html; charset=utf-8").send(page);
  });

  // Public, like the welcome page: no sign-in needed to read it.
  app.get("/howitworks", async (_request, reply) => reply.redirect("/howitworks/"));
  app.get("/howitworks/", async (_request, reply) => {
    try {
      howPage ??= readFileSync(HOW_PAGE, "utf8");
    } catch {
      return reply.redirect("/");
    }
    return reply.header("cache-control", "no-cache").type("text/html; charset=utf-8").send(howPage);
  });

  /** Has this visitor asked already? */
  app.get("/api/account-request", { logLevel: "warn" }, async (request) => {
    const row = getDb().prepare("SELECT name FROM account_requests WHERE ip = ?").get(clientIp(request)) as { name: string } | undefined;
    return { requested: !!row, name: row?.name ?? null };
  });

  app.post<{ Body: { name?: unknown; contact?: unknown; message?: unknown } }>("/api/account-request", async (request, reply) => {
    const name = oneLine(request.body?.name, MAX_NAME);
    const contact = oneLine(request.body?.contact, MAX_CONTACT);
    const message = String(request.body?.message ?? "").slice(0, MAX_MESSAGE).trim();
    if (!name) return reply.code(400).send({ error: "Write your name first" });
    const db = getDb();
    const ip = clientIp(request);
    if (db.prepare("SELECT 1 FROM account_requests WHERE ip = ?").get(ip)) {
      return reply.code(409).send({ error: "You've already asked. An admin will get back to you." });
    }
    const now = Date.now();
    const lastHour = (db.prepare("SELECT COUNT(*) AS n FROM account_requests WHERE created_at >= ?").get(now - 3_600_000) as { n: number }).n;
    if (lastHour >= REQUESTS_PER_HOUR) {
      return reply.code(429).send({ error: "Lots of people are asking right now. Try again in an hour, or message luma_exe on Discord." });
    }
    const id = Number(
      db
        .prepare("INSERT INTO account_requests (ip, name, contact, message, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(ip, name, contact || null, message || null, now).lastInsertRowid
    );
    const lines = [
      `<@${ADMIN_DISCORD_ID}> 📝 **${forDiscord(name)}** is asking for an arcade account`,
      contact ? `Discord: ${forDiscord(contact)}` : "No Discord given",
    ];
    if (message) lines.push(quote(message));
    const delivered = await notify(lines.join("\n"), undefined, 0, now, [ADMIN_DISCORD_ID]);
    db.prepare("UPDATE account_requests SET delivered = ? WHERE id = ?").run(delivered ? 1 : 0, id);
    request.log.info({ name, contact, delivered }, "account requested");
    return { ok: true };
  });

  // --- forgotten passwords: same idea, once a day per visitor

  /** When this visitor last asked for a reset (within a day), if they did. */
  app.get("/api/password-reset", { logLevel: "warn" }, async (request) => {
    const row = getDb()
      .prepare("SELECT created_at FROM password_resets WHERE ip = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1")
      .get(clientIp(request), Date.now() - RESET_EVERY_MS) as { created_at: number } | undefined;
    return { requestedAt: row?.created_at ?? null };
  });

  app.post<{ Body: { name?: unknown; contact?: unknown; message?: unknown } }>("/api/password-reset", async (request, reply) => {
    const name = oneLine(request.body?.name, MAX_NAME);
    const contact = oneLine(request.body?.contact, MAX_CONTACT);
    const message = String(request.body?.message ?? "").slice(0, MAX_MESSAGE).trim();
    if (!name) return reply.code(400).send({ error: "Write the name you sign in with" });
    const db = getDb();
    const ip = clientIp(request);
    const now = Date.now();
    if (db.prepare("SELECT 1 FROM password_resets WHERE ip = ? AND created_at >= ?").get(ip, now - RESET_EVERY_MS)) {
      return reply.code(409).send({ error: "You've already asked today. An admin will get back to you." });
    }
    const lastHour = (db.prepare("SELECT COUNT(*) AS n FROM password_resets WHERE created_at >= ?").get(now - 3_600_000) as { n: number }).n;
    if (lastHour >= REQUESTS_PER_HOUR) {
      return reply.code(429).send({ error: "Lots of people are asking right now. Try again in an hour, or message luma_exe on Discord." });
    }
    const id = Number(
      db
        .prepare("INSERT INTO password_resets (ip, name, contact, message, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(ip, name, contact || null, message || null, now).lastInsertRowid
    );
    const lines = [
      `<@${ADMIN_DISCORD_ID}> 🔑 **${forDiscord(name)}** forgot their arcade password`,
      contact ? `Discord: ${forDiscord(contact)}` : "No Discord given",
    ];
    if (message) lines.push(quote(message));
    const delivered = await notify(lines.join("\n"), undefined, 0, now, [ADMIN_DISCORD_ID]);
    db.prepare("UPDATE password_resets SET delivered = ? WHERE id = ?").run(delivered ? 1 : 0, id);
    request.log.info({ name, contact, delivered }, "password reset requested");
    return { ok: true };
  });

  // --- the admin screen's Requests tab

  app.get("/api/admin/requests", { preHandler: requireAdmin }, async () => {
    const db = getDb();
    const rows = (table: string) =>
      (db
        .prepare(`SELECT id, name, contact, message, created_at, delivered, handled_at, handled_by FROM ${table} ORDER BY created_at DESC LIMIT 100`)
        .all() as RequestRow[]).map(toRequest);
    return { accounts: rows("account_requests"), resets: rows("password_resets") };
  });

  /** Done (or back to pending): { handled: boolean }. */
  app.post<{ Params: { kind: string; id: string }; Body: { handled?: unknown } }>(
    "/api/admin/requests/:kind/:id",
    { preHandler: requireAdmin },
    async (request, reply) => {
      const table = request.params.kind === "account" ? "account_requests" : request.params.kind === "reset" ? "password_resets" : null;
      if (!table) return reply.code(404).send({ error: "No such request" });
      const admin = await streamUser(request);
      const handled = request.body?.handled !== false;
      const changed = getDb()
        .prepare(`UPDATE ${table} SET handled_at = ?, handled_by = ? WHERE id = ?`)
        .run(handled ? Date.now() : null, handled ? admin?.name ?? null : null, Number(request.params.id)).changes;
      return changed ? { ok: true } : reply.code(404).send({ error: "No such request" });
    }
  );
}

interface RequestRow {
  id: number;
  name: string;
  contact: string | null;
  message: string | null;
  created_at: number;
  delivered: number;
  handled_at: number | null;
  handled_by: string | null;
}

const toRequest = (r: RequestRow) => ({
  id: r.id,
  name: r.name,
  contact: r.contact,
  message: r.message,
  createdAt: r.created_at,
  sentToDiscord: !!r.delivered,
  handledAt: r.handled_at,
  handledBy: r.handled_by,
});
