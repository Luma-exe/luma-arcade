import { useEffect, useState } from "react";
import {
  api,
  type AppSettings,
  type CustomAppRow,
  type DependencyStatus,
  type RomFolderRow,
  type UpdateStatus,
} from "../lib/api.js";
import { SELECTABLE_SYSTEM_IDS, getSystemDisplayName } from "../lib/systemNames.js";

export function Settings({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<Partial<AppSettings>>({});
  const [romFolders, setRomFolders] = useState<RomFolderRow[]>([]);
  const [customApps, setCustomApps] = useState<CustomAppRow[]>([]);
  const [dependencies, setDependencies] = useState<DependencyStatus[]>([]);
  const [scanning, setScanning] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [applyingUpdate, setApplyingUpdate] = useState(false);
  const [updateLog, setUpdateLog] = useState<string[] | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings().then(setSettings);
    api.getRomFolders().then(setRomFolders);
    api.getCustomApps().then(setCustomApps);
    rescanDependencies();
    checkUpdate();
  }, []);

  async function checkUpdate() {
    setCheckingUpdate(true);
    try {
      setUpdateStatus(await api.checkForUpdate());
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function handleApplyUpdate() {
    setApplyingUpdate(true);
    setUpdateError(null);
    setUpdateLog(null);
    try {
      const result = await api.applyUpdate();
      setUpdateLog(result.log);
    } catch (err) {
      setUpdateError((err as Error).message);
    } finally {
      setApplyingUpdate(false);
    }
  }

  async function rescanDependencies() {
    setScanning(true);
    try {
      const { dependencies } = await api.getDependencies();
      setDependencies(dependencies);
    } finally {
      setScanning(false);
    }
  }

  async function handleInstall(dep: DependencyStatus) {
    setInstalling(dep.wingetId);
    await api.installDependency(dep.wingetId).catch(() => {});
    setInstalling(null);
  }

  function update(partial: Partial<AppSettings>) {
    setSaved(false);
    setDraft((d) => ({ ...d, ...partial }));
  }

  const view: AppSettings | null = settings && { ...settings, ...draft };
  const dirty = Object.keys(draft).length > 0;

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      const updated = await api.updateSettings(draft);
      setSettings(updated);
      setDraft({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!view) return <div className="center">Loading…</div>;

  return (
    <div className="settings-page">
      <header className="library-header">
        <div className="brand-pill">
          <span className="brand-pill-dot" />
          Luma Arcade
        </div>
      </header>
      <header className="library-header">
        <h1>Settings</h1>
        <div className="header-actions">
          <button onClick={onBack}>Back to Home</button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      <Section title="Dependencies">
        <p className="muted">
          Checks the video pipeline, controller driver, and remote-access tunnel LumaArcade
          relies on. These are normally installed automatically when you run the installer —
          use this if something's missing or you skipped that step.
        </p>
        {dependencies.map((dep) => (
          <div key={dep.id} className="row">
            <span>
              {dep.installed ? "✓" : "✗"} {dep.label}
            </span>
            {!dep.installed && (
              <button onClick={() => handleInstall(dep)} disabled={installing === dep.wingetId}>
                {installing === dep.wingetId ? "Installing…" : "Install"}
              </button>
            )}
          </div>
        ))}
        <button onClick={rescanDependencies} disabled={scanning}>
          {scanning ? "Scanning…" : "Rescan for missing dependencies"}
        </button>
        {installing && (
          <p className="muted">
            Installing in the background — this can take a few minutes for GStreamer. Click
            Rescan afterward to confirm.
          </p>
        )}
      </Section>

      <Section title="Updates">
        {updateStatus?.error && (
          <p className="muted">Couldn't check for updates: {updateStatus.error}</p>
        )}
        {updateStatus && !updateStatus.error && (
          <p className="muted">
            Running commit {updateStatus.localCommit.slice(0, 7)}
            {updateStatus.updateAvailable
              ? ` — an update is available (latest: ${updateStatus.latestCommit?.slice(0, 7)}).`
              : " — up to date."}
            {updateStatus.compareUrl && (
              <>
                {" "}
                <a href={updateStatus.compareUrl} target="_blank" rel="noreferrer">
                  View changes
                </a>
              </>
            )}
          </p>
        )}
        <button onClick={checkUpdate} disabled={checkingUpdate}>
          {checkingUpdate ? "Checking…" : "Check for updates"}
        </button>
        <TextField
          label="Dev tree path (for self-update)"
          value={view.devTreePath}
          onChange={(v) => update({ devTreePath: v })}
        />
        <p className="muted">
          Path to a git checkout of luma-arcade. If set, "Apply update" pulls, rebuilds, and
          deploys it here automatically. Leave blank if this copy was just installed from the
          setup .exe — there's no safe generic way to auto-replace that, so you'd grab a newer
          installer instead.
        </p>
        {updateStatus?.updateAvailable && (
          <button onClick={handleApplyUpdate} disabled={applyingUpdate || !view.devTreePath}>
            {applyingUpdate ? "Updating…" : "Apply update"}
          </button>
        )}
        {updateError && <p className="error">{updateError}</p>}
        {updateLog && (
          <pre className="muted" style={{ whiteSpace: "pre-wrap", fontSize: "0.8rem" }}>
            {updateLog.join("\n")}
          </pre>
        )}
      </Section>

      <Section title="General">
        <Toggle
          label="Start LumaArcade when Windows starts"
          checked={view.autoStart}
          onChange={(v) => update({ autoStart: v })}
        />
        <TextField
          label="Port"
          value={String(view.port)}
          onChange={(v) => update({ port: Number(v) || 7777 })}
        />
        <p className="muted">Takes effect after restarting LumaArcade.</p>
      </Section>

      <Section title="Controls">
        <TextField
          label="Mouse sensitivity"
          value={String(view.mouseSensitivity)}
          onChange={(v) => update({ mouseSensitivity: Number(v) || 1 })}
        />
        <p className="muted">1 = normal speed. Lower for finer control, higher for faster movement.</p>
        <Toggle
          label="Invert scroll direction"
          checked={view.invertScroll}
          onChange={(v) => update({ invertScroll: v })}
        />
        <TextField
          label="Gamepad deadzone"
          value={String(view.gamepadDeadzone)}
          onChange={(v) => update({ gamepadDeadzone: Math.min(1, Math.max(0, Number(v) || 0)) })}
        />
        <p className="muted">
          0 to 1. Stick movement smaller than this is ignored — raise it if a controller drifts
          on its own.
        </p>
      </Section>

      <Section title="Launch Mode">
        <p className="muted">
          Standalone shows LumaArcade's own home screen when you open the portal, with
          Full Desktop as one tile among Steam/Epic/etc. ES-DE mode skips straight to a live
          window into a real, natively-installed ES-DE (EmulationStation Desktop Edition) —
          launched automatically, or attached to if it's already running.
        </p>
        <label className="field-row">
          Mode
          <select
            value={view.launchMode}
            onChange={(e) => update({ launchMode: e.target.value as "standalone" | "esde" })}
          >
            <option value="standalone">Standalone</option>
            <option value="esde">ES-DE</option>
          </select>
        </label>
        {view.launchMode === "esde" && (
          <TextField
            label="ES-DE executable path"
            value={view.esdeExePath}
            onChange={(v) => update({ esdeExePath: v })}
          />
        )}
        <p className="muted">
          You can also switch modes anytime from the tray icon — right-click it and choose
          "Switch to ES-DE Mode" / "Switch to Standalone Mode".
        </p>
      </Section>

      {view.launchMode === "standalone" && (
        <Section title="Sources">
          <Toggle label="Steam" checked={view.steamEnabled} onChange={(v) => update({ steamEnabled: v })} />
          <Toggle label="Epic Games" checked={view.epicEnabled} onChange={(v) => update({ epicEnabled: v })} />
          <Toggle
            label="Emulation"
            checked={view.emulationEnabled}
            onChange={(v) => update({ emulationEnabled: v })}
          />
          <Toggle
            label="Custom apps"
            checked={view.customAppsEnabled}
            onChange={(v) => update({ customAppsEnabled: v })}
          />
          <Toggle
            label="Full Desktop access"
            checked={view.fullDesktopEnabled}
            onChange={(v) => update({ fullDesktopEnabled: v })}
          />
        </Section>
      )}

      <Section title="Box art (IGDB)">
        <p className="muted">
          Requires a free Twitch developer app — create one at dev.twitch.tv/console/apps.
        </p>
        <TextField label="Client ID" value={view.igdbClientId} onChange={(v) => update({ igdbClientId: v })} />
        <TextField
          label="Client Secret"
          value={view.igdbClientSecret}
          type="password"
          onChange={(v) => update({ igdbClientSecret: v })}
        />
      </Section>

      <Section title="Video">
        <TextField
          label="Framerate"
          value={String(view.framerate)}
          onChange={(v) => update({ framerate: Number(v) || 60 })}
        />
        <label className="field-row">
          Bitrate: {(view.bitrateKbps / 1000).toFixed(1)} Mbps
          <input
            type="range"
            min={1000}
            max={20000}
            step={500}
            value={view.bitrateKbps}
            onChange={(e) => update({ bitrateKbps: Number(e.target.value) })}
          />
        </label>
        <label className="field-row">
          NVENC preset
          <select
            value={view.nvencPreset}
            onChange={(e) => update({ nvencPreset: e.target.value })}
          >
            <option value="default">Default</option>
            <option value="hp">High Performance</option>
            <option value="hq">High Quality</option>
            <option value="low-latency">Low Latency</option>
            <option value="low-latency-hq">Low Latency, High Quality</option>
            <option value="low-latency-hp">Low Latency, High Performance</option>
            <option value="lossless">Lossless</option>
            <option value="lossless-hp">Lossless, High Performance</option>
          </select>
        </label>
      </Section>

      <Section title="Network">
        <Toggle
          label="Enable remote access via Cloudflare Tunnel"
          checked={view.remoteAccessEnabled}
          onChange={(v) => update({ remoteAccessEnabled: v })}
        />
        {view.remoteAccessEnabled && (
          <>
            <TextField
              label="Cloudflare Tunnel token"
              value={view.cloudflareTunnelToken}
              type="password"
              onChange={(v) => update({ cloudflareTunnelToken: v })}
            />
            <Toggle
              label="Run local TURN relay (coturn)"
              checked={view.turnServerEnabled}
              onChange={(v) => update({ turnServerEnabled: v })}
            />
            <TextField
              label="coturn turnserver.exe path"
              value={view.turnServerBinaryPath}
              onChange={(v) => update({ turnServerBinaryPath: v })}
            />
            {view.turnServerEnabled && (
              <>
                <p className="muted">
                  TURN carries raw UDP media traffic, which a Cloudflare Tunnel can't proxy —
                  port-forward the TURN port on your router and enter the public IP or DDNS
                  hostname below.
                </p>
                <TextField
                  label="Public host/IP for TURN"
                  value={view.turnPublicHost}
                  onChange={(v) => update({ turnPublicHost: v })}
                />
                <TextField
                  label="TURN port"
                  value={String(view.turnPort)}
                  onChange={(v) => update({ turnPort: Number(v) || 3478 })}
                />
              </>
            )}
          </>
        )}
      </Section>

      {view.launchMode === "standalone" && (
        <Section title="ROM folders">
          {romFolders.map((f) => (
            <div key={f.id} className="row">
              <span>
                {getSystemDisplayName(f.console)}: {f.folder_path} → {f.emulator_exe_path}
              </span>
              <button onClick={async () => setRomFolders(await api.removeRomFolder(f.id))}>Remove</button>
            </div>
          ))}
          <RomFolderForm onAdd={async (body) => setRomFolders(await api.addRomFolder(body))} />
        </Section>
      )}

      {view.launchMode === "standalone" && (
        <Section title="Custom apps">
          {customApps.map((a) => (
            <div key={a.id} className="row">
              <span>
                {a.display_name}: {a.exe_path}
              </span>
              <button onClick={async () => setCustomApps(await api.removeCustomApp(a.id))}>Remove</button>
            </div>
          ))}
          <CustomAppForm onAdd={async (body) => setCustomApps(await api.addCustomApp(body))} />
        </Section>
      )}

      <div className="save-bar">
        {dirty && !saving && <span className="unsaved">You have unsaved changes</span>}
        {saved && <span className="unsaved">Saved</span>}
        <button onClick={handleSave} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="settings-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function TextField({
  label,
  value,
  type = "text",
  onChange,
}: {
  label: string;
  value: string;
  type?: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="field-row">
      {label}
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function RomFolderForm({
  onAdd,
}: {
  onAdd: (body: {
    console: string;
    folderPath: string;
    emulatorExePath: string;
    launchArgsTemplate: string;
  }) => void;
}) {
  const [consoleName, setConsoleName] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [emulatorExePath, setEmulatorExePath] = useState("");
  const [launchArgsTemplate, setLaunchArgsTemplate] = useState("{rom}");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!consoleName || !folderPath || !emulatorExePath) return;
    onAdd({ console: consoleName, folderPath, emulatorExePath, launchArgsTemplate });
    setConsoleName("");
    setFolderPath("");
    setEmulatorExePath("");
    setLaunchArgsTemplate("{rom}");
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      <select value={consoleName} onChange={(e) => setConsoleName(e.target.value)}>
        <option value="">Console…</option>
        {SELECTABLE_SYSTEM_IDS.map((id) => (
          <option key={id} value={id}>
            {getSystemDisplayName(id)}
          </option>
        ))}
      </select>
      <input
        placeholder="ROM folder path"
        value={folderPath}
        onChange={(e) => setFolderPath(e.target.value)}
      />
      <input
        placeholder="Emulator .exe path"
        value={emulatorExePath}
        onChange={(e) => setEmulatorExePath(e.target.value)}
      />
      <input
        placeholder="Launch args ({rom} placeholder)"
        value={launchArgsTemplate}
        onChange={(e) => setLaunchArgsTemplate(e.target.value)}
      />
      <button type="submit">Add</button>
    </form>
  );
}

function CustomAppForm({
  onAdd,
}: {
  onAdd: (body: { displayName: string; exePath: string }) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [exePath, setExePath] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!displayName || !exePath) return;
    onAdd({ displayName, exePath });
    setDisplayName("");
    setExePath("");
  }

  return (
    <form className="inline-form" onSubmit={submit}>
      <input
        placeholder="Display name"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
      />
      <input
        placeholder=".exe or .lnk path"
        value={exePath}
        onChange={(e) => setExePath(e.target.value)}
      />
      <button type="submit">Add</button>
    </form>
  );
}
