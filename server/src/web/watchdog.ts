import type { FastifyBaseLogger } from "fastify";
import { getDb } from "../db/index.js";
import { gamesByUser } from "./games.js";
import { notify } from "./notify.js";
import { nameUnnamedApps, playSummary } from "./playLog.js";
import { sunshineAppName } from "./sunshine.js";
import { checkDiskSpace, checkSaveBackup, checkSunshine, restartSunshine } from "./routes/health.js";
import { nobodyStreamingFor, status as sessionStatus } from "./sessions.js";

// Keeping the PC right without anyone watching:
//  - Sunshine's HTTPS side sometimes hangs (the PC then shows as offline in
//    the arcade); when it has for HUNG_CHECKS checks in a row and nobody is
//    streaming, restart Sunshine (what Host Health's button does);
//  - a failed nightly backup or a nearly full disk goes to Discord;
//  - Monday mornings, the week's play summary goes to Discord;
//  - play history rows named "App <id>" get the app's name.

const CHECK_MS = 60_000;
const HUNG_CHECKS = 3;
/** Don't restart Sunshine more often than this (it isn't helping then). */
const RESTART_EVERY_MS = 30 * 60_000;
/** Backup and disk checks: every this many Sunshine checks (10 min). */
const SLOW_EVERY = 10;
const WEEKLY_SETTING = "weeklySummarySent";

let hungInARow = 0;
let lastRestart = 0;
let ticks = 0;
const lastStatus = new Map<string, string>();

/** One Sunshine check. Returns what it did, for the log/tests. */
export async function watchSunshine(
  check: () => Promise<{ hung: boolean }>,
  restart: () => Promise<void>,
  now = Date.now()
): Promise<"ok" | "hung" | "restarted" | "waiting"> {
  const { hung } = await check();
  if (!hung) {
    hungInARow = 0;
    return "ok";
  }
  hungInARow++;
  if (hungInARow < HUNG_CHECKS || now - lastRestart < RESTART_EVERY_MS) return "hung";
  // Restarting drops whoever is streaming (their browser still shows video
  // over the part that works); leave it to Host Health's button then.
  if (sessionStatus(null).streaming || nobodyStreamingFor(now) === 0) return "waiting";
  lastRestart = now;
  hungInARow = 0;
  await restart();
  return "restarted";
}

/** Tests. */
export function resetWatchdog(): void {
  hungInARow = 0;
  lastRestart = 0;
  ticks = 0;
  lastStatus.clear();
}

/** Posts a check to Discord when it turns bad (not again until it's been fine). */
async function alertOnChange(check: { id: string; label: string; status: string; detail: string }): Promise<void> {
  const before = lastStatus.get(check.id);
  lastStatus.set(check.id, check.status);
  if (check.status === "error" && before !== "error") void notify(`⚠️ ${check.label}: ${check.detail}`);
}

// --- the weekly summary

function hours(ms: number): string {
  const h = ms / 3_600_000;
  return h >= 1 ? `${h.toFixed(h >= 10 ? 0 : 1)} h` : `${Math.max(1, Math.round(ms / 60_000))} min`;
}

/** The last 7 days of play as a Discord message (null if nobody played). */
export function weeklySummary(now = Date.now()): string | null {
  const summary = playSummary(7, 0, now);
  if (!summary.byUser.length) return null;
  const games = gamesByUser(summary.since, now);
  const total = summary.byUser.reduce((sum, u) => sum + u.ms, 0);
  const lines = [
    `📊 **This week on the arcade**: ${hours(total)} played by ${summary.byUser.length} ${summary.byUser.length === 1 ? "person" : "people"}`,
  ];
  for (const u of summary.byUser.slice(0, 10)) {
    const top = (games.get(u.userId) ?? []).slice(0, 3).map((g) => `${g.title} ${hours(g.ms)}`);
    lines.push(`• **${u.user}** ${hours(u.ms)}${top.length ? ` (${top.join(", ")})` : ""}`);
  }
  return lines.join("\n");
}

/** "2026-W40": which week a summary was sent for. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

async function maybeSendWeekly(now = new Date()): Promise<void> {
  // Mondays from 9 am.
  if (now.getDay() !== 1 || now.getHours() < 9) return;
  const week = isoWeek(now);
  const db = getDb();
  const sent = db.prepare("SELECT value FROM settings WHERE key = ?").get(WEEKLY_SETTING) as { value: string } | undefined;
  if (sent?.value === week) return;
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(WEEKLY_SETTING, week);
  const text = weeklySummary(now.getTime());
  if (text) await notify(text);
}

// --- running it

let timer: NodeJS.Timeout | null = null;

export function startWatchdog(log: FastifyBaseLogger): void {
  if (timer) return;
  timer = setInterval(() => {
    void (async () => {
      const outcome = await watchSunshine(
        async () => ({ hung: (await checkSunshine())[0]?.detail.startsWith("Stuck") ?? false }),
        restartSunshine
      );
      if (outcome === "restarted") {
        log.warn("Sunshine's secure port was stuck with nobody streaming: restarted it");
        void notify("🔁 Sunshine was stuck (the PC showed as offline), so it was restarted");
      }
      if (ticks++ % SLOW_EVERY === 0) {
        // Streams saved as "App <id>" (Sunshine was restarting when luma
        // asked for its app list) get their names once it answers.
        await nameUnnamedApps(sunshineAppName).catch(() => 0);
        await alertOnChange(await checkSaveBackup());
        await alertOnChange(checkDiskSpace());
        await maybeSendWeekly();
      }
    })().catch((err: Error) => log.warn({ err }, "watchdog check failed"));
  }, CHECK_MS);
  timer.unref();
}
