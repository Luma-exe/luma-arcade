import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAccess, setAccess } from "../access.js";
import { closeStreamsOf } from "../appAccess.js";
import { isRateLimited, recordFailedAttempt } from "../auth.js";
import {
  allLinks,
  cleanDefaults,
  cleanUpAccounts,
  getGuestDefaults,
  setGuestDefaults,
  convertLink,
  createLink,
  getLink,
  guestAllowance,
  linkByToken,
  linkState,
  recordUse,
  removeLink,
  revokeLink,
  signIn,
  updateLink,
  type GuestLinkRow,
  type GuestMode,
} from "../guestLinks.js";
import { pendingCount, sendMessage, takeMessages } from "../messages.js";
import { clientIp } from "../requestOrigin.js";
import { requireAuth } from "../session.js";
import { answerInvite, createInvite, endInvitesFrom, endInvitesTo, joinableStream, playingUserIds } from "../sessions.js";
import { clearStreamUserCache, requireAdmin, streamUser, type StreamUser } from "../streamUser.js";
import { MOONLIGHT_PATH_PREFIX } from "../../remote/moonlightWebStream.js";
import { sturdySetCookieHeader } from "../sessionCookie.js";
import { coverFile, launchableGame, queueLaunch } from "../games.js";
import { gameStreams } from "./games.js";
import { PITCH, SLOGAN, isPreviewBot, previewPage, siteOrigin } from "../linkPreview.js";

// Guest links (guestLinks.ts): /g/<token> signs the visitor in as the
// link's own account and sends them to the arcade, straight into a game
// the admin picked, or into the creator's game as player 2. Admins make, watch, message, extend, kick and
// revoke them; anyone can be sent a message.

function page(reply: FastifyReply, status: number, title: string, text: string, retry = false) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return reply
    .code(status)
    .type("text/html; charset=utf-8")
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - Luma Arcade</title>
<style>
:root{color-scheme:light dark;--bg:#eef3f9;--card:#fff;--text:#10233b;--muted:#5b6b80;--accent:#1f6fd1}
@media (prefers-color-scheme:dark){:root{--bg:#0b1220;--card:#151e2e;--text:#e8eef7;--muted:#9aa8bb;--accent:#4a8ff0}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px;box-sizing:border-box}
main{max-width:420px;width:100%;background:var(--card);border-radius:16px;padding:28px 24px;box-shadow:0 12px 32px rgba(0,0,0,.15);text-align:center}
h1{font-size:22px;margin:0 0 10px}p{margin:0 0 18px;color:var(--muted);line-height:1.5}
a{display:inline-block;padding:10px 20px;border-radius:10px;background:var(--accent);color:#fff;text-decoration:none;font-weight:600}
</style></head><body><main><h1>${esc(title)}</h1><p>${esc(text)}</p>${retry ? '<a href="">Try again</a>' : ""}</main></body></html>`);
}

function guestUser(link: GuestLinkRow): StreamUser {
  return { id: link.user_id, name: link.user_name, roleId: 0, admin: false };
}

function linkGame(link: GuestLinkRow) {
  const game = link.game_play_id ? launchableGame(link.game_play_id) : null;
  return game ? { id: game.id, title: game.title, system: game.system, coverId: coverFile(game) ? game.id : null } : null;
}

function view(link: GuestLinkRow, playing: Set<number>, now = Date.now()) {
  const allowance = link.account_deleted_at ? null : guestAllowance(link.user_id, now);
  return {
    id: link.id,
    name: link.name,
    mode: link.mode,
    path: `/g/${link.token}`,
    userId: link.user_id,
    userName: link.user_name,
    state: linkState(link, now),
    playing: playing.has(link.user_id),
    minutes: link.minutes,
    usedMs: allowance?.usedMs ?? 0,
    remainingMs: allowance?.remainingMs ?? 0,
    expiresAt: link.expires_at,
    createdAt: link.created_at,
    createdBy: link.created_by,
    uses: link.uses,
    firstUsedAt: link.first_used_at,
    lastUsedAt: link.last_used_at,
    pendingMessages: pendingCount(link.user_id),
    accountDeleted: !!link.account_deleted_at,
    convertedTo: link.converted_at ? link.converted_to_name : null,
    convertedToId: link.converted_at ? link.converted_to_user_id : null,
    access: getAccess(link.user_id),
    game: linkGame(link),
  };
}

function toId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Bad id");
  return id;
}

/** A new link's choices: whatever the request says, the rest from the
 * admin's defaults. A player-2 link joins whatever game its creator plays,
 * so it never gets an app list. */
function parseNew(body: unknown, mode?: GuestMode) {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 40) : "Guest";
  const choices = cleanDefaults(mode ? { ...b, mode } : b, getGuestDefaults());
  if (choices.mode === "coop") return { ...choices, name, apps: null, gameId: null };
  // A game to open straight into; its app (ES-DE) has to be one they may start.
  let apps = choices.apps;
  let gameId: number | null = null;
  if (b.gameId != null && b.gameId !== "") {
    const game = launchableGame(Number(b.gameId));
    if (!game) throw new Error("That game can't be started from a link - pick another");
    gameId = game.id;
    if (apps && !apps.includes(game.app)) apps = [...apps, game.app];
  }
  return { ...choices, name, apps, gameId };
}

async function adminAction(request: FastifyRequest, reply: FastifyReply, run: (admin: StreamUser, cookie: string) => Promise<unknown> | unknown) {
  const admin = await streamUser(request);
  if (!admin?.admin) return reply.code(403).send({ error: "Only admins can do that" });
  try {
    return await run(admin, request.headers.cookie ?? "");
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
}

export async function registerGuestLinkRoutes(app: FastifyInstance) {
  // --- opening a link

  app.get<{ Params: { token: string } }>("/g/:token", async (request, reply) => {
    // Discord, WhatsApp and the like open the link to draw its preview:
    // show them the invite, without signing in, using up the link or
    // starting the game.
    if (isPreviewBot(request.headers["user-agent"])) {
      const link = /^[A-Za-z0-9_-]{16,64}$/.test(request.params.token) ? linkByToken(request.params.token) : null;
      const game = link?.mode === "play" && link.game_play_id ? launchableGame(link.game_play_id) : null;
      const title = game
        ? `Play ${game.title} on Luma Arcade`
        : link?.mode === "coop"
          ? `Join ${link.created_by}'s game on Luma Arcade`
          : "You're invited to Luma Arcade";
      const origin = siteOrigin(request);
      return reply
        .header("cache-control", "no-store")
        .type("text/html; charset=utf-8")
        .send(previewPage({ title, description: `${SLOGAN} ${PITCH}`, url: origin + request.url, origin }));
    }
    const ip = clientIp(request);
    if (isRateLimited(ip)) return page(reply, 429, "Slow down", "Too many tries. Wait a minute and open the link again.");
    const link = /^[A-Za-z0-9_-]{16,64}$/.test(request.params.token) ? linkByToken(request.params.token) : null;
    if (!link) {
      recordFailedAttempt(ip);
      return page(reply, 404, "This link doesn't work", "Check you copied all of it, or ask for a new one.");
    }
    const allowance = link.account_deleted_at ? { remainingMs: 0, reason: "This guest link was turned off." } : guestAllowance(link.user_id);
    if (!allowance || allowance.remainingMs <= 0) {
      return page(reply, 410, "This link has ended", allowance?.reason ?? "Ask for a new one!");
    }

    let target = `${MOONLIGHT_PATH_PREFIX}/`;
    const game = link.mode === "play" && link.game_play_id ? launchableGame(link.game_play_id) : null;
    if (game) {
      // Straight into its stream; once that's up, the stream page's
      // ?continue=1 starts the game (POST /api/continue). If ES-DE is gone,
      // they just land in the arcade.
      const stream = await gameStreams.find(game);
      if (stream) {
        queueLaunch(link.user_id, game.id);
        const query = new URLSearchParams({ hostId: String(stream.hostId), appId: String(stream.appId), continue: "1" });
        target = `${MOONLIGHT_PATH_PREFIX}/stream.html?${query}`;
      }
    } else if (link.mode === "coop") {
      // Straight into the creator's game, if they're playing.
      const stream = joinableStream(link.created_by_id);
      if (!stream) {
        return page(reply, 409, `${link.created_by} isn't playing right now`, "This link lets you join their game as player 2 while they're playing. Try again once they've started.", true);
      }
      const host = { id: link.created_by_id, name: link.created_by, roleId: 0, admin: false };
      const invite = createInvite(host, guestUser(link), stream);
      if ("error" in invite) return page(reply, 409, "Couldn't join", invite.error, true);
      answerInvite(invite.id, guestUser(link), true);
      const query = new URLSearchParams({ hostId: String(stream.hostId), appId: String(stream.appId), coop: invite.id });
      target = `${MOONLIGHT_PATH_PREFIX}/stream.html?${query}`;
    }

    let cookies: string[];
    try {
      cookies = await signIn(link);
    } catch (err) {
      return page(reply, 502, "Couldn't sign you in", `The arcade didn't answer (${(err as Error).message}). Try again in a moment.`, true);
    }
    recordUse(link);
    clearStreamUserCache();
    reply.header("set-cookie", sturdySetCookieHeader(cookies));
    reply.header("cache-control", "no-store");
    return reply.redirect(target);
  });

  // --- admins

  // Defaults for new links: type, play time, lifetime, apps, settings access.
  app.get("/api/admin/guest-links/defaults", { preHandler: requireAdmin }, async () => getGuestDefaults());

  app.put("/api/admin/guest-links/defaults", { preHandler: requireAdmin }, (request, reply) =>
    adminAction(request, reply, () => setGuestDefaults(request.body))
  );

  app.get("/api/admin/guest-links", { preHandler: requireAdmin }, async (request) => {
    // Needs an admin's session, so old accounts are tidied up now.
    await cleanUpAccounts(request.headers.cookie ?? "").catch(() => 0);
    const playing = playingUserIds();
    return { links: allLinks().map((l) => view(l, playing)) };
  });

  app.post("/api/admin/guest-links", { preHandler: requireAdmin }, (request, reply) =>
    adminAction(request, reply, async (admin, cookie) => {
      const input = parseNew(request.body);
      const link = await createLink(cookie, admin, input);
      if (input.apps || input.settings) setAccess(link.user_id, { apps: input.apps, settings: input.settings });
      clearStreamUserCache();
      return view(link, playingUserIds());
    })
  );

  app.patch<{ Params: { id: string }; Body: { minutes?: number | null; hours?: number | null } }>(
    "/api/admin/guest-links/:id",
    { preHandler: requireAdmin },
    (request, reply) =>
      adminAction(request, reply, () => {
        const b = request.body ?? {};
        const minutes = b.minutes === undefined ? undefined : b.minutes === null ? null : Math.round(Number(b.minutes));
        if (minutes != null && !(minutes > 0 && minutes <= 7 * 24 * 60)) throw new Error("Play time must be between 1 minute and a week");
        const hours = b.hours == null ? null : Number(b.hours);
        if (hours != null && !(hours > 0 && hours <= 24 * 90)) throw new Error("A link can last up to 90 days");
        return view(updateLink(toId(request.params.id), { minutes, hours }), playingUserIds());
      })
  );

  /** End their stream now; the link keeps working. */
  app.post<{ Params: { id: string }; Body: { reason?: string } }>("/api/admin/guest-links/:id/kick", { preHandler: requireAdmin }, (request, reply) =>
    adminAction(request, reply, () => {
      const link = getLink(toId(request.params.id));
      if (!link) throw new Error("No such link");
      const reason = String(request.body?.reason ?? "").trim().slice(0, 100) || "An admin ended your stream";
      endInvitesFrom(link.user_id, reason);
      endInvitesTo(link.user_id, reason);
      return { closed: closeStreamsOf(link.user_id, reason) };
    })
  );

  /** Kick, and turn the link off for good. */
  app.post<{ Params: { id: string } }>("/api/admin/guest-links/:id/revoke", { preHandler: requireAdmin }, (request, reply) =>
    adminAction(request, reply, async (_admin, cookie) => {
      const link = getLink(toId(request.params.id));
      if (!link) throw new Error("No such link");
      endInvitesTo(link.user_id, "This guest link was turned off");
      closeStreamsOf(link.user_id, "This guest link was turned off");
      await revokeLink(cookie, link.id);
      clearStreamUserCache();
      return { ok: true };
    })
  );

  app.delete<{ Params: { id: string } }>("/api/admin/guest-links/:id", { preHandler: requireAdmin }, (request, reply) =>
    adminAction(request, reply, async (_admin, cookie) => {
      const link = getLink(toId(request.params.id));
      if (!link) throw new Error("No such link");
      endInvitesTo(link.user_id, "This guest link was turned off");
      closeStreamsOf(link.user_id, "This guest link was turned off");
      await removeLink(cookie, link.id);
      clearStreamUserCache();
      return { ok: true };
    })
  );

  /** Make a real account from this guest: their saves, favorites,
   * snapshots and play history go with them, and the link is turned off. */
  app.post<{ Params: { id: string }; Body: { name?: string; password?: string; roleId?: number } }>(
    "/api/admin/guest-links/:id/convert",
    { preHandler: requireAdmin },
    (request, reply) =>
      adminAction(request, reply, async (_admin, cookie) => {
        const link = getLink(toId(request.params.id));
        if (!link) throw new Error("No such link");
        const b = request.body ?? {};
        // They're signed out of the guest account, so end their stream first
        // (and the saves are then settled on disk).
        endInvitesTo(link.user_id, "Your guest pass became an account - sign in with it");
        closeStreamsOf(link.user_id, "Your guest pass became an account - sign in with it");
        const done = await convertLink(cookie, link.id, {
          name: String(b.name ?? "").trim(),
          password: String(b.password ?? ""),
          roleId: Number(b.roleId),
        });
        clearStreamUserCache();
        return view(done, playingUserIds());
      })
  );

  /** A player-2 link for the admin's own game, from the stream page. */
  app.post("/api/coop/link", { preHandler: requireAdmin }, (request, reply) =>
    adminAction(request, reply, async (admin, cookie) => {
      const input = parseNew(request.body, "coop");
      const link = await createLink(cookie, admin, input);
      if (input.settings) setAccess(link.user_id, { apps: null, settings: input.settings });
      return view(link, playingUserIds());
    })
  );

  // --- messages (anyone an admin picks: guest links or people)

  app.post<{ Body: { userId?: number; text?: string } }>("/api/admin/messages", { preHandler: requireAdmin }, (request, reply) =>
    adminAction(request, reply, (admin) => sendMessage(toId(request.body?.userId), admin, request.body?.text))
  );

  app.get("/api/messages", { preHandler: requireAuth, logLevel: "warn" }, async (request) => {
    const user = await streamUser(request);
    return { messages: user ? takeMessages(user.id) : [] };
  });
}
