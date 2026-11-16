import type { FastifyInstance } from "fastify";
import { createReadStream, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSetting } from "../../config/settings.js";
import { getDb } from "../../db/index.js";
import { dataPath } from "../../platform.js";
import { MOONLIGHT_PATH_PREFIX } from "../../remote/moonlightWebStream.js";
import { notify } from "../notify.js";
import { clientIp } from "../requestOrigin.js";
import { PITCH, SLOGAN, withPreview } from "../linkPreview.js";
import { requireAdmin, streamUser } from "../streamUser.js";

// arcade.lumaplayground.com's front page: what this is, Sign in, and for
// people without an account, "Request an account" - which pings the admin
// on Discord (settings: discordWebhookUrl) with their name, Discord and
// message. One request per visitor address, and a cap on all of them so
// nobody can use it to spam the admin.
//
// A private arcade (settings: privateServer) takes neither: the page says
// so and points visitors at setting up their own.
//
// The sign-in cookie only exists under /stream, so the page itself asks
// /stream/luma-api/me whether you're signed in and goes straight on if so.

/** Who gets pinged for account requests: the adminDiscordId setting, or
 * nobody when it's empty. */
function adminMention(): { ping: string; users: string[] } {
  const id = getSetting("adminDiscordId");
  return /^\d{5,25}$/.test(id) ? { ping: `<@${id}> `, users: [id] } : { ping: "", users: [] };
}
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
/** /docs/: the setup guide, with its own pictures in pages/docs-img/. */
const DOCS_PAGE = path.join(PAGES, "docs.html");
let docsPage: string | null = null;
const DOCS_IMG = /^[a-z0-9][a-z0-9-]{0,40}\.(png|jpg|jpeg|webp)$/;

/** The landing pages' gameplay clips and art live outside git (copyrighted),
 * in <data dir>/landing-media/<dir>/<file>. Other installs just don't have it. */
const MEDIA_DIRS = new Set(["clips", "covers", "shots", "fanart", "marquees", "3dboxes", "physical", "ui"]);
const MEDIA_FILE = /^[a-z0-9][a-z0-9-]{0,40}\.(mp4|png|jpg|jpeg|webp)$/;
const MEDIA_TYPES: Record<string, string> = { mp4: "video/mp4", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
/** Read per request so LUMA_DATA_DIR can be changed (tests). */
const mediaFile = (dir: string, file: string) =>
  process.env.LUMA_DATA_DIR ? path.join(process.env.LUMA_DATA_DIR, "landing-media", dir, file) : dataPath("landing-media", dir, file);

/** One "bytes=a-b" range of `size` bytes: [start, end], or null when unsatisfiable. */
export function parseRange(header: string, size: number): [number, number] | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]); // the last n bytes
    if (n === 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start >= size || start > end ? null : [start, end];
}

/** What the request forms get back on a private arcade. */
const PRIVATE_ERROR = "This arcade is private. Luma Arcade is free: set up your own at github.com/Luma-exe/luma-arcade";

/** The welcome page, marked private (body class) when the arcade is. */
export function welcomePage(html: string, isPrivate: boolean): string {
  return isPrivate ? html.replace('<body class="checking">', '<body class="checking private-server">') : html;
}

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
    return reply
      .header("cache-control", "no-cache")
      .type("text/html; charset=utf-8")
      .send(withPreview(welcomePage(page, getSetting("privateServer")), request, `Luma Arcade - ${SLOGAN}`, PITCH));
  });

  // Public, like the welcome page: no sign-in needed to read it.
  app.get("/howitworks", async (_request, reply) => reply.redirect("/howitworks/"));
  app.get("/howitworks/", async (request, reply) => {
    try {
      howPage ??= readFileSync(HOW_PAGE, "utf8");
    } catch {
      return reply.redirect("/");
    }
    return reply
      .header("cache-control", "no-cache")
      .type("text/html; charset=utf-8")
      .send(withPreview(howPage, request, "How Luma Arcade works", `${SLOGAN} How it streams a real gaming PC to your browser, and everything it does for the people playing.`));
  });

  // /docs/: the setup guide. Its pictures (installer pages, sign-in, touch
  // controls) are Luma Arcade's own and ship in pages/docs-img/.
  for (const alias of ["/docs", "/setup", "/setup/"]) app.get(alias, async (_request, reply) => reply.redirect("/docs/"));
  app.get("/docs/", async (request, reply) => {
    try {
      docsPage ??= readFileSync(DOCS_PAGE, "utf8");
    } catch {
      return reply.redirect("/");
    }
    return reply
      .header("cache-control", "no-cache")
      .type("text/html; charset=utf-8")
      .send(withPreview(docsPage, request, "Set up Luma Arcade", "Step by step: what your PC needs, every Setup page, signing in, adding games and inviting friends."));
  });
  app.get<{ Params: { file: string } }>("/docs/img/:file", async (request, reply) => {
    const { file } = request.params;
    if (!DOCS_IMG.test(file)) return reply.code(404).send({ error: "Not found" });
    const full = path.join(PAGES, "docs-img", file);
    let size: number;
    try {
      const st = statSync(full);
      if (!st.isFile()) throw new Error("not a file");
      size = st.size;
    } catch {
      return reply.code(404).send({ error: "Not found" });
    }
    return reply
      .header("content-type", MEDIA_TYPES[file.slice(file.lastIndexOf(".") + 1)])
      .header("cache-control", "public, max-age=86400")
      .header("content-length", size)
      .send(createReadStream(full));
  });

  // The landing pages' clips and art (see MEDIA_DIRS). Public; 404 when absent.
  app.get<{ Params: { dir: string; file: string } }>("/landing-media/:dir/:file", async (request, reply) => {
    const { dir, file } = request.params;
    if (!MEDIA_DIRS.has(dir) || !MEDIA_FILE.test(file)) return reply.code(404).send({ error: "Not found" });
    let size: number;
    const full = mediaFile(dir, file);
    try {
      const st = statSync(full);
      if (!st.isFile()) throw new Error("not a file");
      size = st.size;
    } catch {
      return reply.code(404).send({ error: "Not found" });
    }
    reply
      .header("content-type", MEDIA_TYPES[file.slice(file.lastIndexOf(".") + 1)])
      .header("cache-control", "public, max-age=86400")
      .header("accept-ranges", "bytes");
    const range = request.headers.range;
    if (range && file.endsWith(".mp4")) {
      const r = parseRange(range, size);
      if (!r) return reply.code(416).header("content-range", `bytes */${size}`).send();
      const [start, end] = r;
      return reply
        .code(206)
        .header("content-range", `bytes ${start}-${end}/${size}`)
        .header("content-length", end - start + 1)
        .send(createReadStream(full, { start, end }));
    }
    return reply.header("content-length", size).send(createReadStream(full));
  });

  /** Has this visitor asked already? */
  app.get("/api/account-request", { logLevel: "warn" }, async (request) => {
    const row = getDb().prepare("SELECT name FROM account_requests WHERE ip = ?").get(clientIp(request)) as { name: string } | undefined;
    return { requested: !!row, name: row?.name ?? null };
  });

  app.post<{ Body: { name?: unknown; contact?: unknown; message?: unknown } }>("/api/account-request", async (request, reply) => {
    if (getSetting("privateServer")) return reply.code(403).send({ error: PRIVATE_ERROR });
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
    const mention = adminMention();
    const lines = [
      `${mention.ping}📝 **${forDiscord(name)}** is asking for an arcade account`,
      contact ? `Discord: ${forDiscord(contact)}` : "No Discord given",
    ];
    if (message) lines.push(quote(message));
    const delivered = await notify(lines.join("\n"), undefined, 0, now, mention.users);
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
    if (getSetting("privateServer")) return reply.code(403).send({ error: PRIVATE_ERROR });
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
    const mention = adminMention();
    const lines = [
      `${mention.ping}🔑 **${forDiscord(name)}** forgot their arcade password`,
      contact ? `Discord: ${forDiscord(contact)}` : "No Discord given",
    ];
    if (message) lines.push(quote(message));
    const delivered = await notify(lines.join("\n"), undefined, 0, now, mention.users);
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
