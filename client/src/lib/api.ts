export interface AppSettings {
  port: number;
  autoStart: boolean;

  moonlightWebStreamPath: string;
  moonlightWebStreamPort: number;
  moonlightAutoStart: boolean;

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
    fetch("/api/moonlight/status").then((r) =>
      json<{ reachable: boolean; processRunning: boolean; lastError?: string }>(r)
    ),

  checkForUpdate: () => fetch("/api/update/check").then((r) => json<UpdateStatus>(r)),
  applyUpdate: () =>
    fetch("/api/update/apply", { method: "POST" }).then((r) =>
      json<{ ok: boolean; log: string[]; error?: string }>(r)
    ),
};
