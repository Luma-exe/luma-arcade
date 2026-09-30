import { getDb } from "../db/index.js";

// The one-time stream setup: before a player's first stream,
// moonlight-web-stream's setup.html asks "steady or automatic quality?" and
// runs a 30-second speed test to pick settings for that choice. Done once
// per account (a guest link is an account too), kept here so a new browser
// doesn't ask again and can start from the same settings.

export type QualityMode = "static" | "auto";

/** The stream settings the setup may pick (moonlight-web-stream's default_settings.js). */
export interface SetupSettings {
  autoQuality: boolean;
  bitrate?: number;
  fps?: number;
  videoSize?: string;
  videoCodec?: string;
  videoFrameQueueSize?: number;
}

export interface StreamSetup {
  done: boolean;
  mode: QualityMode | null;
  settings: SetupSettings | null;
  at: number | null;
}

const SIZES = new Set(["720p", "1080p", "1440p", "4k", "native"]);
const CODECS = new Set(["h264", "h265", "av1", "auto"]);

const intIn = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;

/** Only the settings the setup picks, each checked; the mode decides autoQuality. */
export function cleanSetupSettings(mode: QualityMode, input: unknown): SetupSettings {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const settings: SetupSettings = { autoQuality: mode === "auto" };
  const bitrate = intIn(raw.bitrate, 500, 150_000);
  const fps = intIn(raw.fps, 24, 240);
  const queue = intIn(raw.videoFrameQueueSize, 1, 10);
  if (bitrate !== undefined) settings.bitrate = bitrate;
  if (fps !== undefined) settings.fps = fps;
  if (queue !== undefined) settings.videoFrameQueueSize = queue;
  if (typeof raw.videoSize === "string" && SIZES.has(raw.videoSize)) settings.videoSize = raw.videoSize;
  if (typeof raw.videoCodec === "string" && CODECS.has(raw.videoCodec)) settings.videoCodec = raw.videoCodec;
  return settings;
}

export function getStreamSetup(userId: number): StreamSetup {
  const row = getDb()
    .prepare("SELECT quality_mode, quality_settings, quality_setup_at FROM user_prefs WHERE user_id = ?")
    .get(userId) as { quality_mode: string | null; quality_settings: string | null; quality_setup_at: number | null } | undefined;
  if (!row || row.quality_setup_at == null) return { done: false, mode: null, settings: null, at: null };
  let settings: SetupSettings | null = null;
  try {
    settings = row.quality_settings ? (JSON.parse(row.quality_settings) as SetupSettings) : null;
  } catch {}
  return {
    done: true,
    mode: row.quality_mode === "auto" ? "auto" : "static",
    settings,
    at: row.quality_setup_at,
  };
}

/** Saves the setup. Before a first stream only the first one counts (false
 * if it was already done); redo (run again from Settings) replaces it. */
export function saveStreamSetup(userId: number, mode: QualityMode, settings: SetupSettings, now = Date.now(), redo = false): boolean {
  if (!redo && getStreamSetup(userId).done) return false;
  getDb()
    .prepare(
      `INSERT INTO user_prefs (user_id, share_playing, updated_at, quality_mode, quality_settings, quality_setup_at)
       VALUES (@userId, 0, @now, @mode, @settings, @now)
       ON CONFLICT(user_id) DO UPDATE SET quality_mode = excluded.quality_mode, quality_settings = excluded.quality_settings,
         quality_setup_at = excluded.quality_setup_at, updated_at = excluded.updated_at`
    )
    .run({ userId, now, mode, settings: JSON.stringify(settings) });
  return true;
}

/** A guest who becomes a real account keeps their setup (guestLinks.ts convertLink). */
export function copyStreamSetup(fromUserId: number, toUserId: number): void {
  const from = getStreamSetup(fromUserId);
  if (from.done && from.mode) saveStreamSetup(toUserId, from.mode, from.settings ?? { autoQuality: from.mode === "auto" }, from.at ?? Date.now());
}
