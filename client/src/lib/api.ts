export interface AppSettings {
  port: number;
  autoStart: boolean;

  moonlightWebStreamPath: string;
  moonlightWebStreamPort: number;
  moonlightAutoStart: boolean;

  devTreePath: string;
}

export interface SetupResult {
  detected: {
    sunshineConfigDir: string | null;
    esdeExePath: string | null;
    moonlightWebStreamExePath: string | null;
  };
  esdeAddedToSunshine: boolean;
  moonlightPathUpdated: boolean;
  notes: string[];
}

export interface UpdateStatus {
  localCommit: string;
  builtAt: string;
  latestCommit: string | null;
  updateAvailable: boolean;
  compareUrl: string | null;
  error?: string;
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

  getMoonlightStatus: () =>
    fetch("/api/moonlight/status").then((r) => json<{ reachable: boolean }>(r)),
  runSetup: () => fetch("/api/setup/run", { method: "POST" }).then((r) => json<SetupResult>(r)),

  checkForUpdate: () => fetch("/api/update/check").then((r) => json<UpdateStatus>(r)),
  applyUpdate: (password: string) =>
    fetch("/api/update/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).then((r) => json<{ ok: boolean; log: string[]; error?: string }>(r)),
};
