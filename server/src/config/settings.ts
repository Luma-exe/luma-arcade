import { getDb } from "../db/index.js";

export interface AppSettings {
  port: number;
  autoStart: boolean;

  /** Path to the moonlight-web-stream executable/launcher on this machine.
   * LumaArcade spawns and manages it as a child process (same pattern the
   * old cloudflared/coturn integration used) when moonlightAutoStart is on. */
  moonlightWebStreamPath: string;
  moonlightWebStreamPort: number;
  moonlightAutoStart: boolean;

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

  moonlightWebStreamPath: "",
  moonlightWebStreamPort: 8080,
  moonlightAutoStart: false,

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
