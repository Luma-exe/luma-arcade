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
  launchMode: "standalone" | "esde";
  esdeExePath: string;

  mouseSensitivity: number;
  invertScroll: boolean;
  gamepadDeadzone: number;

  devTreePath: string;
}

export interface UpdateStatus {
  localCommit: string;
  builtAt: string;
  latestCommit: string | null;
  updateAvailable: boolean;
  compareUrl: string | null;
  error?: string;
}

export interface GameRow {
  id: number;
  source: "steam" | "epic" | "emulation" | "custom";
  external_id: string | null;
  title: string;
  launch_target: string;
  console: string | null;
  box_art_url: string | null;
  last_played_at: string | null;
  genre: string | null;
  developer: string | null;
  release_year: number | null;
  description: string | null;
  rating_5: number | null;
  metadata_checked_at: string | null;
}

export interface RomFolderRow {
  id: number;
  console: string;
  folder_path: string;
  emulator_exe_path: string;
  launch_args_template: string;
}

export interface DependencyStatus {
  id: "gstreamer" | "vigembus" | "cloudflared";
  label: string;
  installed: boolean;
  wingetId: string;
}

export interface CustomAppRow {
  id: number;
  display_name: string;
  exe_path: string;
  icon_path: string | null;
}

export interface DisplayInfo {
  index: number;
  width: number;
  height: number;
  primary: boolean;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

export const api = {
  getSettings: () => fetch("/api/settings").then((r) => json<AppSettings>(r)),
  updateSettings: (partial: Partial<AppSettings>) =>
    fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(partial),
    }).then((r) => json<AppSettings>(r)),

  getGames: (source?: string) =>
    fetch(`/api/games${source ? `?source=${source}` : ""}`).then((r) => json<GameRow[]>(r)),
  getConsoles: () => fetch("/api/consoles").then((r) => json<string[]>(r)),
  scanLibrary: () => fetch("/api/library/scan", { method: "POST" }).then((r) => json(r)),
  launchGame: (id: number) =>
    fetch(`/api/games/${id}/launch`, { method: "POST" }).then((r) =>
      json<{ ok: boolean; pid?: number }>(r)
    ),

  switchToDesktop: (monitorIndex?: number) =>
    fetch("/api/stream/switch-to-desktop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ monitorIndex }),
    }).then((r) => json(r)),
  getStreamStatus: () =>
    fetch("/api/stream/status").then((r) =>
      json<{
        running: boolean;
        mode: "desktop" | "game";
        gameId?: number;
        pid?: number;
        monitorIndex?: number;
      }>(r)
    ),
  getDisplays: () => fetch("/api/displays").then((r) => json<{ displays: DisplayInfo[] }>(r)),

  getRomFolders: () => fetch("/api/rom-folders").then((r) => json<RomFolderRow[]>(r)),
  addRomFolder: (body: {
    console: string;
    folderPath: string;
    emulatorExePath: string;
    launchArgsTemplate: string;
  }) =>
    fetch("/api/rom-folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<RomFolderRow[]>(r)),
  removeRomFolder: (id: number) =>
    fetch(`/api/rom-folders/${id}`, { method: "DELETE" }).then((r) => json<RomFolderRow[]>(r)),

  getRdpStatus: () => fetch("/api/rdp-status").then((r) => json<{ connected: boolean }>(r)),

  checkForUpdate: () => fetch("/api/update/check").then((r) => json<UpdateStatus>(r)),
  applyUpdate: () =>
    fetch("/api/update/apply", { method: "POST" }).then((r) =>
      json<{ ok: boolean; log: string[]; error?: string }>(r)
    ),

  getDependencies: () =>
    fetch("/api/dependencies").then((r) => json<{ dependencies: DependencyStatus[] }>(r)),
  installDependency: (wingetId: string) =>
    fetch("/api/dependencies/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wingetId }),
    }).then((r) => json<{ ok: boolean; started: boolean }>(r)),

  esdeLaunch: () =>
    fetch("/api/esde/launch", { method: "POST" }).then((r) =>
      json<{ ok: boolean; pid?: number; alreadyRunning?: boolean; error?: string }>(r)
    ),

  getCustomApps: () => fetch("/api/custom-apps").then((r) => json<CustomAppRow[]>(r)),
  addCustomApp: (body: { displayName: string; exePath: string }) =>
    fetch("/api/custom-apps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<CustomAppRow[]>(r)),
  removeCustomApp: (id: number) =>
    fetch(`/api/custom-apps/${id}`, { method: "DELETE" }).then((r) => json<CustomAppRow[]>(r)),
};
