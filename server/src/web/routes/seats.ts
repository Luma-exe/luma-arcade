import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readFileSync } from "node:fs";
import path from "node:path";
import { listUsers } from "../../remote/moonlightData.js";
import { isLocalRequest } from "../requestOrigin.js";
import {
  SEATS_DIR,
  createSeat,
  powerSeat,
  prepareHost,
  recheckHost,
  removeSeat,
  repairSeat,
  retrySeat,
  seatsOverview,
  syncPairing,
  validateNewSeat,
} from "../seatAdmin.js";
import { requireAdmin, streamUser } from "../streamUser.js";

// Settings > Extra seats (web/seatAdmin.ts). Admins only. What changes this
// PC itself - turning on Hyper-V and its policies, building or deleting a
// seat - only from the home network, like the server's paths and ports
// (routes/settings.ts): a leaked admin password shouldn't be enough.

function homeOnly(request: FastifyRequest, reply: FastifyReply, what: string): boolean {
  if (isLocalRequest(request)) return true;
  reply.code(403).send({ error: `${what} only works from the home network` });
  return false;
}

async function attempt(reply: FastifyReply, work: () => Promise<unknown>) {
  try {
    return (await work()) ?? { ok: true };
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
}

export async function registerSeatRoutes(app: FastifyInstance) {
  app.get("/api/admin/seats/manage", { preHandler: requireAdmin, logLevel: "warn" }, async () => seatsOverview());

  app.post("/api/admin/seats/check", { preHandler: requireAdmin }, async (_req, reply) => attempt(reply, recheckHost));

  app.post<{ Body: { allowGpuPolicy?: boolean; storage?: string } }>("/api/admin/seats/prepare", { preHandler: requireAdmin }, async (req, reply) => {
    if (!homeOnly(req, reply, "Getting this PC ready for seats")) return;
    req.log.info({ allowGpuPolicy: !!req.body?.allowGpuPolicy }, "preparing the PC for extra seats");
    return attempt(reply, () => prepareHost({ allowGpuPolicy: !!req.body?.allowGpuPolicy, storage: req.body?.storage }));
  });

  app.post("/api/admin/seats", { preHandler: requireAdmin }, async (req, reply) => {
    if (!homeOnly(req, reply, "Adding a seat")) return;
    return attempt(reply, async () => {
      const overview = await seatsOverview();
      const seat = validateNewSeat(req.body, overview.host ?? null);
      const name = await createSeat(seat);
      req.log.info({ seat: name, memoryGb: seat.memoryGb, cpus: seat.cpus, gpuShare: seat.gpuShare }, "building a seat");
      return { ok: true, name };
    });
  });

  app.post<{ Params: { name: string; op: string } }>("/api/admin/seats/:name/:op", { preHandler: requireAdmin }, async (req, reply) => {
    const { name, op } = req.params;
    return attempt(reply, async () => {
      if (op === "repair") await repairSeat(name);
      else if (op === "retry") await retrySeat(name);
      else if (op === "pair") await syncPairing({ now: true }, req.log);
      else if (op === "start" || op === "stop" || op === "restart") await powerSeat(name, op);
      else throw new Error("Unknown action");
      req.log.info({ seat: name, op }, "seat action");
      return { ok: true };
    });
  });

  app.delete<{ Params: { name: string }; Querystring: { force?: string } }>("/api/admin/seats/:name", { preHandler: requireAdmin }, async (req, reply) => {
    if (!homeOnly(req, reply, "Removing a seat")) return;
    const admin = await streamUser(req);
    return attempt(reply, async () => {
      const result = await removeSeat(req.params.name, {
        force: req.query.force === "1",
        players: listUsers().map((u) => ({ id: u.id, name: u.name })),
      });
      req.log.info({ seat: req.params.name, admin: admin?.name, ...result }, "seat removed");
      return { ok: true, ...result };
    });
  });

  // The seat's build log (seats\logs\<name>.log): the last lines.
  app.get<{ Params: { name: string } }>("/api/admin/seats/:name/log", { preHandler: requireAdmin, logLevel: "warn" }, async (req, reply) => {
    const name = req.params.name;
    if (!/^Seat\d{1,2}$/.test(name) && name !== "manager") return reply.code(404).send({ error: "No such seat" });
    try {
      const lines = readFileSync(path.join(SEATS_DIR, "logs", `${name}.log`), "utf8").split(/\r?\n/).filter(Boolean);
      return { lines: lines.slice(-200) };
    } catch {
      return { lines: [] };
    }
  });
}
