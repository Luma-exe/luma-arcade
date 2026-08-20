import { useEffect, useState } from "react";
import { api, type AppSettings, type CustomAppRow, type RomFolderRow } from "../lib/api.js";
import { SELECTABLE_SYSTEM_IDS, getSystemDisplayName } from "../lib/systemNames.js";

export function Settings({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<Partial<AppSettings>>({});
  const [romFolders, setRomFolders] = useState<RomFolderRow[]>([]);
  const [customApps, setCustomApps] = useState<CustomAppRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings().then(setSettings);
    api.getRomFolders().then(setRomFolders);
    api.getCustomApps().then(setCustomApps);
  }, []);

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

      <Section title="General">
        <Toggle
          label="Start LumaArcade when Windows starts"
          checked={view.autoStart}
          onChange={(v) => update({ autoStart: v })}
        />
      </Section>

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
        <TextField
          label="Bitrate (kbps)"
          value={String(view.bitrateKbps)}
          onChange={(v) => update({ bitrateKbps: Number(v) || 8000 })}
        />
        <TextField
          label="NVENC preset"
          value={view.nvencPreset}
          onChange={(v) => update({ nvencPreset: v })}
        />
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
