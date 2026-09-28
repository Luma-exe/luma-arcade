import { getDb } from "../db/index.js";

/** Settings screen sections an admin can open up or lock per person. Admin
 * only sections (Host Health, LumaArcade server) never show for players. */
export const SETTINGS_SECTIONS = [
  { id: "quality", name: "Stream quality & video" },
  { id: "audio", name: "Audio" },
  { id: "input", name: "Mouse & keyboard" },
  { id: "controller", name: "Controllers" },
  { id: "touch", name: "Touch controls" },
  { id: "saves", name: "My saves (snapshots)" },
  { id: "sidebar", name: "Stream sidebar" },
  { id: "other", name: "Language & other" },
] as const;

export interface UserAccess {
  /** Sunshine app names they may start; null = all apps */
  apps: string[] | null;
  /** settings sections they may open; null = all player sections */
  settings: string[] | null;
}

const OPEN: UserAccess = { apps: null, settings: null };

function parseList(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : null;
  } catch {
    return null;
  }
}

export function getAccess(userId: number): UserAccess {
  const row = getDb().prepare("SELECT apps, settings FROM user_access WHERE user_id = ?").get(userId) as
    | { apps: string | null; settings: string | null }
    | undefined;
  if (!row) return { ...OPEN };
  return { apps: parseList(row.apps), settings: parseList(row.settings) };
}

export function getAllAccess(): Record<number, UserAccess> {
  const rows = getDb().prepare("SELECT user_id, apps, settings FROM user_access").all() as {
    user_id: number;
    apps: string | null;
    settings: string | null;
  }[];
  const out: Record<number, UserAccess> = {};
  for (const r of rows) out[r.user_id] = { apps: parseList(r.apps), settings: parseList(r.settings) };
  return out;
}

export function setAccess(userId: number, access: UserAccess): void {
  const apps = access.apps === null ? null : JSON.stringify(access.apps);
  const known: string[] = SETTINGS_SECTIONS.map((s) => s.id);
  const settings = access.settings === null ? null : JSON.stringify(access.settings.filter((s) => known.includes(s)));
  getDb()
    .prepare(
      `INSERT INTO user_access (user_id, apps, settings) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET apps = excluded.apps, settings = excluded.settings, updated_at = datetime('now')`
    )
    .run(userId, apps, settings);
}

export function deleteAccess(userId: number): void {
  getDb().prepare("DELETE FROM user_access WHERE user_id = ?").run(userId);
}

export function isAppAllowed(access: UserAccess, appName: string | undefined): boolean {
  if (access.apps === null) return true;
  return !!appName && access.apps.includes(appName);
}
