import { getDb } from "../db/index.js";

export interface AppSettings {
  port: number;
  autoStart: boolean;

  steamEnabled: boolean;
  epicEnabled: boolean;
  emulationEnabled: boolean;
  customAppsEnabled: boolean;
  fullDesktopEnabled: boolean;

  igdbClientId: string;
  igdbClientSecret: string;

  framerate: number;
  bitrateKbps: number;
  nvencPreset: string;

  remoteAccessEnabled: boolean;
  cloudflareTunnelToken: string;
  turnServerBinaryPath: string;
  turnServerEnabled: boolean;
  turnSharedSecret: string;
  turnRealm: string;
  turnPort: number;
  turnPublicHost: string;

  /** 'standalone' = opening the portal shows LumaArcade's own carousel home
   * screen (Full Desktop is one tile among Steam/Epic/etc). 'esde' = opening
   * the portal skips straight to a live view of a real, natively-installed
   * ES-DE (EmulationStation Desktop Edition) instance — launched (or
   * attached to, if already running) and window-captured automatically,
   * for users who already run real ES-DE on this PC and want LumaArcade to
   * be a pure remote window into it rather than its own front-end. */
  launchMode: "standalone" | "esde";
  esdeExePath: string;

  mouseSensitivity: number;
  invertScroll: boolean;
  gamepadDeadzone: number;

  /** Path to a git checkout of luma-arcade (e.g. the same source tree this
   * build was compiled from) — enables the Settings "Apply update" button to
   * self-update via `git pull` + rebuild. Left empty, updates are still
   * detected and surfaced but the app won't touch any files: there's no
   * generic safe way to auto-replace a running installed .exe, so a plain
   * install without a configured dev tree only gets a "there's an update,
   * here's the repo" prompt. */
  devTreePath: string;
}

const DEFAULTS: AppSettings = {
  port: 7777,
  autoStart: false,

  steamEnabled: true,
  epicEnabled: true,
  emulationEnabled: true,
  customAppsEnabled: true,
  fullDesktopEnabled: true,

  igdbClientId: "",
  igdbClientSecret: "",

  framerate: 60,
  bitrateKbps: 8000,
  nvencPreset: "low-latency-hq",

  remoteAccessEnabled: false,
  cloudflareTunnelToken: "",
  turnServerBinaryPath: "",
  turnServerEnabled: false,
  turnSharedSecret: "",
  turnRealm: "lumaarcade.local",
  turnPort: 3478,
  turnPublicHost: "",

  launchMode: "standalone",
  esdeExePath: "",

  mouseSensitivity: 1,
  invertScroll: false,
  gamepadDeadzone: 0.08,

  devTreePath: "",
};

export function getSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;

  if (!row) return DEFAULTS[key];
  return JSON.parse(row.value) as AppSettings[K];
}

export function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(key, JSON.stringify(value));
}

export function getAllSettings(): AppSettings {
  const result = {} as AppSettings;
  for (const key of Object.keys(DEFAULTS) as (keyof AppSettings)[]) {
    (result as any)[key] = getSetting(key);
  }
  return result;
}

export function setSettings(partial: Partial<AppSettings>): void {
  for (const [key, value] of Object.entries(partial)) {
    setSetting(key as keyof AppSettings, value as any);
  }
}
