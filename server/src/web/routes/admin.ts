import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SETTINGS_SECTIONS, deleteAccess, getAccess, getAllAccess, setAccess, type UserAccess } from "../access.js";
import { requireAuth } from "../session.js";
import { clearStreamUserCache, requireAdmin, streamUser } from "../streamUser.js";
import { adminKick, decide, guestStream, liveSessions, status as sessionStatus, type SessionDecision } from "../sessions.js";
import { claimSeat, isSeatHost, seatDecision, seatOffer, seatsStatus } from "../seats.js";
import { forceStop } from "../idle.js";
import { playSummary, usage } from "../playLog.js";
import { gamesByApp } from "../games.js";
import { weeklySummary } from "../watchdog.js";
import { getAllLimits, setLimits, timeLeft } from "../limits.js";
import { activeAnnouncements, postAnnouncement, removeAnnouncement } from "../announcements.js";
import {
  copyAllDevices,
  copyDevice,
  deleteDevice,
  editData,
  listDevices,
  listUsers,
  readData,
  setDeviceOwner,
} from "../../remote/moonlightData.js";

const SUNSHINE_DIR = "C:\\Program Files\\Sunshine";

interface SunshineApp {
  name: string;
  "image-path"?: string;
}

/** Sunshine's apps (apps.json), with their cover images inlined. */
function sunshineApps(): { name: string; image: string | null }[] {
  // PowerShell 5.1 (Setup, the helper scripts) saves it with a byte order mark.
  const text = readFileSync(path.join(SUNSHINE_DIR, "config", "apps.json"), "utf8").replace(/^﻿/, "");
  const config = JSON.parse(text) as {
    apps: SunshineApp[];
  };
  return config.apps.map((app) => {
    let image: string | null = null;
    const file = app["image-path"];
    if (file) {
      for (const candidate of [file, path.join(SUNSHINE_DIR, "assets", file), path.join(SUNSHINE_DIR, "config", file)]) {
        try {
          image = `data:image/png;base64,${readFileSync(candidate).toString("base64")}`;
          break;
        } catch {
          // try the next location
        }
      }
    }
    return { name: app.name, image };
  });
}

function parseAccess(body: unknown): UserAccess {
  const b = (body ?? {}) as { apps?: unknown; settings?: unknown };
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);
  return { apps: list(b.apps), settings: list(b.settings) };
}

function toId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Bad id");
  return id;
}

/** Who you are and what you may do (every page), and the admin screen's
 * data: per-person app and settings access, and devices (paired hosts). */
export async function registerAdminRoutes(app: FastifyInstance) {
  app.get("/api/access/me", { preHandler: requireAuth }, async (request) => {
    const user = await streamUser(request);
    if (!user) return { user: null, admin: false, apps: null, settings: null, sections: SETTINGS_SECTIONS };
    const access = user.admin ? { apps: null, settings: null } : getAccess(user.id);
    return { user: { id: user.id, name: user.name }, admin: user.admin, ...access, sections: SETTINGS_SECTIONS };
  });

  // Who has the PC right now, and whether this person may connect
  // (sessions.ts): the PC card and the stream page ask before connecting.
  // ?hostId= names the PC the page is about to connect to: an extra seat
  // (seats.ts) answers for itself. For the main PC, newSession says whether
  // a seat is free (or already theirs) for "Start a new session".
  app.get<{ Querystring: { hostId?: string } }>("/api/sessions/status", { preHandler: requireAuth, logLevel: "warn" }, async (request) => {
    const user = await streamUser(request);
    const hostId = Number(request.query.hostId);
    if (user && hostId && isSeatHost(hostId)) {
      let decision: SessionDecision = seatDecision(hostId, user);
      if (decision.allowed && decision.reason) decision = { ...decision, takeOver: true };
      try {
        const left = timeLeft(user);
        if (left.remainingMs === 0) decision = { allowed: false, reason: left.reason };
      } catch {}
      return { ...sessionStatus(user), decision, coop: null, seat: true };
    }
    let decision = user ? decide(user) : { allowed: false };
    // Out of play time beats everything else (limits.ts).
    if (user) {
      try {
        const left = timeLeft(user);
        if (left.remainingMs === 0) decision = { allowed: false, reason: left.reason };
      } catch {}
    }
    // A co-op guest's page asks the host for exactly the player's stream.
    const newSession = user ? await seatOffer(user).catch(() => null) : null;
    return { ...sessionStatus(user), decision, coop: user ? guestStream(user) : null, newSession };
  });

  // "Start a new session": a free seat for this person (or theirs again).
  app.post("/api/seats/claim", { preHandler: requireAuth }, async (request, reply) => {
    const user = await streamUser(request);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const seat = await claimSeat(user);
    if (!seat) return reply.code(409).send({ error: "Every other PC is in use right now" });
    request.log.info({ player: user.name, seat: seat.name }, "seat claimed");
    return { hostId: seat.hostId, name: seat.name };
  });

  app.get("/api/admin/seats", { preHandler: requireAdmin, logLevel: "warn" }, async () => ({ seats: seatsStatus() }));

  // Live now (admin screen): everyone streaming, and an admin's say over it
  // from anywhere - remove one person, or end everything and close the game.
  app.get("/api/admin/live", { preHandler: requireAdmin, logLevel: "warn" }, async () => liveSessions());

  app.post<{ Params: { id: string } }>("/api/admin/live/:id/kick", { preHandler: requireAdmin }, async (req, reply) => {
    const admin = await streamUser(req);
    if (!admin) return reply.code(401).send({ error: "unauthorized" });
    const result = adminKick(admin, toId(req.params.id));
    if ("error" in result) return reply.code(409).send(result);
    req.log.info({ admin: admin.name, target: Number(req.params.id) }, "admin removed someone from the stream");
    return result;
  });

  app.post("/api/admin/live/stop", { preHandler: requireAdmin }, async (req, reply) => {
    const admin = await streamUser(req);
    if (!admin) return reply.code(401).send({ error: "unauthorized" });
    const result = await forceStop(admin.name);
    req.log.info({ admin: admin.name, ...result }, "admin force-stopped the session");
    return result;
  });

  app.get("/api/admin/apps", { preHandler: requireAdmin }, async (_req, reply) => {
    try {
      return { apps: sunshineApps() };
    } catch (err) {
      return reply.code(500).send({ error: `Couldn't read Sunshine's apps: ${(err as Error).message}` });
    }
  });

  app.get("/api/admin/access", { preHandler: requireAdmin }, async () => ({
    access: getAllAccess(),
    sections: SETTINGS_SECTIONS,
  }));

  app.put<{ Params: { id: string } }>("/api/admin/access/:id", { preHandler: requireAdmin }, async (req, reply) => {
    try {
      setAccess(toId(req.params.id), parseAccess(req.body));
      clearStreamUserCache();
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/admin/access/:id", { preHandler: requireAdmin }, async (req) => {
    deleteAccess(toId(req.params.id));
    return { ok: true };
  });

  // Play history: who played what, and for how long (playLog.ts).
  app.get<{ Querystring: { days?: string } }>("/api/admin/playtime", { preHandler: requireAdmin }, async (req) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const summary = playSummary(days);
    // Which games inside each app (ES-DE), for the By app card's drop-down.
    let games = new Map<string, unknown[]>();
    try {
      games = gamesByApp(summary.since);
    } catch {}
    return { ...summary, byApp: summary.byApp.map((a) => ({ ...a, games: games.get(a.app) ?? [] })) };
  });

  // The Monday Discord post, to preview (watchdog.ts).
  app.get("/api/admin/weekly-summary", { preHandler: requireAdmin }, async () => ({ text: weeklySummary() }));

  // Play time limits per person, with what they've used (limits.ts).
  app.get("/api/admin/limits", { preHandler: requireAdmin }, async () => {
    const limits = getAllLimits();
    const used: Record<number, { todayMs: number; weekMs: number }> = {};
    for (const u of listUsers()) used[u.id] = usage(u.id);
    return { limits, used };
  });

  app.put<{ Params: { id: string } }>("/api/admin/limits/:id", { preHandler: requireAdmin }, async (req, reply) => {
    try {
      return { limits: setLimits(toId(req.params.id), req.body) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // Announcements (announcements.ts).
  app.get("/api/admin/announcements", { preHandler: requireAdmin }, async () => ({ announcements: activeAnnouncements() }));

  app.post<{ Body: { text?: string; hours?: number } }>("/api/admin/announcements", { preHandler: requireAdmin }, async (req, reply) => {
    const user = await streamUser(req);
    try {
      return postAnnouncement(req.body?.text, user?.name ?? "Admin", req.body?.hours);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/admin/announcements/:id", { preHandler: requireAdmin }, async (req) => {
    removeAnnouncement(toId(req.params.id));
    return { ok: true };
  });

  // --- devices (moonlight-web-stream hosts)

  app.get("/api/admin/devices", { preHandler: requireAdmin }, async () => {
    const data = readData();
    return { devices: listDevices(data), users: listUsers(data) };
  });

  const deviceAction = <B>(
    url: string,
    method: "POST" | "DELETE",
    run: (data: Parameters<Parameters<typeof editData>[0]>[0], id: number, body: B) => number | void
  ) =>
    app.route<{ Params: { id: string }; Body: B }>({
      url,
      method,
      preHandler: requireAdmin,
      handler: async (req, reply) => {
        try {
          const id = req.params.id ? toId(req.params.id) : 0;
          const changed = await editData((data) => run(data, id, req.body as B));
          clearStreamUserCache();
          return { ok: true, changed: changed ?? 1, devices: listDevices() };
        } catch (err) {
          return reply.code(400).send({ error: (err as Error).message });
        }
      },
    });

  deviceAction<{ userIds?: number[] }>("/api/admin/devices/:id/copy", "POST", (data, id, body) =>
    copyDevice(data, id, (body?.userIds ?? []).map(toId))
  );
  deviceAction<{ owner?: number | null }>("/api/admin/devices/:id/owner", "POST", (data, id, body) =>
    setDeviceOwner(data, id, body?.owner == null ? null : toId(body.owner))
  );
  deviceAction<unknown>("/api/admin/devices/:id", "DELETE", (data, id) => deleteDevice(data, id));
  deviceAction<{ from?: number; to?: number }>("/api/admin/devices/copy-all", "POST", (data, _id, body) =>
    copyAllDevices(data, toId(body?.from), toId(body?.to))
  );
}
