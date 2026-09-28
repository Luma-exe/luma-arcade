import { getDb } from "../db/index.js";

// Messages an admin posts for everyone ("PC restarting at 11pm"): shown on
// the arcade's home screen and once on stream pages.

export interface Announcement {
  id: number;
  text: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
}

const MAX_TEXT = 500;

function toAnnouncement(r: { id: number; text: string; created_by: string; created_at: number; expires_at: number | null }): Announcement {
  return { id: r.id, text: r.text, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at };
}

/** The ones showing now, newest first. */
export function activeAnnouncements(now = Date.now()): Announcement[] {
  return (
    getDb()
      .prepare("SELECT * FROM announcements WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC")
      .all(now) as Parameters<typeof toAnnouncement>[0][]
  ).map(toAnnouncement);
}

export function postAnnouncement(text: unknown, by: string, hours: unknown, now = Date.now()): Announcement {
  const clean = typeof text === "string" ? text.trim().slice(0, MAX_TEXT) : "";
  if (!clean) throw new Error("Write something to announce");
  const h = Number(hours);
  const expiresAt = Number.isFinite(h) && h > 0 ? now + Math.min(h, 24 * 30) * 3_600_000 : null;
  const id = Number(
    getDb()
      .prepare("INSERT INTO announcements (text, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(clean, by, now, expiresAt).lastInsertRowid
  );
  return { id, text: clean, createdBy: by, createdAt: now, expiresAt };
}

export function removeAnnouncement(id: number): void {
  getDb().prepare("DELETE FROM announcements WHERE id = ?").run(id);
}
