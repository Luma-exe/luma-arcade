import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SETTINGS_SECTIONS, deleteAccess, getAccess, getAllAccess, setAccess, type UserAccess } from "../access.js";
import { requireAuth } from "../session.js";
import { clearStreamUserCache, requireAdmin, streamUser } from "../streamUser.js";
import { decide, status as sessionStatus } from "../sessions.js";
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
  const config = JSON.parse(readFileSync(path.join(SUNSHINE_DIR, "config", "apps.json"), "utf8")) as {
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
  app.get("/api/sessions/status", { preHandler: requireAuth }, async (request) => {
    const user = await streamUser(request);
    return { ...sessionStatus(user), decision: user ? decide(user) : { allowed: false } };
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
