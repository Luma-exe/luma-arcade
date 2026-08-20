import { useEffect, useState } from "react";
import { api, type AppSettings, type CustomAppRow, type RomFolderRow } from "../lib/api.js";

export function Settings({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [romFolders, setRomFolders] = useState<RomFolderRow[]>([]);
  const [customApps, setCustomApps] = useState<CustomAppRow[]>([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings().then(setSettings);
    api.getRomFolders().then(setRomFolders);
    api.getCustomApps().then(setCustomApps);
  }, []);

  async function save(partial: Partial<AppSettings>) {
    setError(null);
    try {
      const updated = await api.updateSettings(partial);
      setSettings(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!settings) return <div className="center">Loading…</div>;

  return (
    <div className="settings-page">
      <header className="library-header">
        <h1>Settings</h1>
        <div className="header-actions">
          {saved && <span className="muted">Saved</span>}
          <button onClick={onBack}>Back to Library</button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      <Section title="General">
        <Toggle
          label="Start LumaArcade when Windows starts"
          checked={settings.autoStart}
          onChange={(v) => save({ autoStart: v })}
        />
      </Section>

      <Section title="Sources">
        <Toggle
          label="Steam"
          checked={settings.steamEnabled}
          onChange={(v) => save({ steamEnabled: v })}
        />
        <Toggle
          label="Epic Games"
          checked={settings.epicEnabled}
          onChange={(v) => save({ epicEnabled: v })}
        />
        <Toggle
          label="Emulation"
          checked={settings.emulationEnabled}
          onChange={(v) => save({ emulationEnabled: v })}
        />
        <Toggle
          label="Custom apps"
          checked={settings.customAppsEnabled}
          onChange={(v) => save({ customAppsEnabled: v })}
        />
        <Toggle
          label="Full Desktop access"
          checked={settings.fullDesktopEnabled}
          onChange={(v) => save({ fullDesktopEnabled: v })}
        />
      </Section>

      <Section title="Box art (IGDB)">
        <p className="muted">
          Requires a free Twitch developer app — create one at dev.twitch.tv/console/apps.
        </p>
        <TextField
          label="Client ID"
          value={settings.igdbClientId}
          onBlur={(v) => save({ igdbClientId: v })}
        />
        <TextField
          label="Client Secret"
          value={settings.igdbClientSecret}
          type="password"
          onBlur={(v) => save({ igdbClientSecret: v })}
        />
      </Section>

      <Section title="Video">
        <TextField
          label="Framerate"
          value={String(settings.framerate)}
          onBlur={(v) => save({ framerate: Number(v) || 60 })}
        />
        <TextField
          label="Bitrate (kbps)"
          value={String(settings.bitrateKbps)}
          onBlur={(v) => save({ bitrateKbps: Number(v) || 8000 })}
        />
        <TextField
          label="NVENC preset"
          value={settings.nvencPreset}
          onBlur={(v) => save({ nvencPreset: v })}
        />
      </Section>

      <Section title="Network">
        <Toggle
          label="Enable remote access via Cloudflare Tunnel"
          checked={settings.remoteAccessEnabled}
          onChange={(v) => save({ remoteAccessEnabled: v })}
        />
        {settings.remoteAccessEnabled && (
          <>
            <TextField
              label="Cloudflare Tunnel token"
              value={settings.cloudflareTunnelToken}
              type="password"
              onBlur={(v) => save({ cloudflareTunnelToken: v })}
            />
            <Toggle
              label="Run local TURN relay (coturn)"
              checked={settings.turnServerEnabled}
              onChange={(v) => save({ turnServerEnabled: v })}
            />
            <TextField
              label="coturn turnserver.exe path"
              value={settings.turnServerBinaryPath}
              onBlur={(v) => save({ turnServerBinaryPath: v })}
            />
            {settings.turnServerEnabled && (
              <>
                <p className="muted">
                  TURN carries raw UDP media traffic, which a Cloudflare Tunnel can't proxy —
                  port-forward the TURN port on your router and enter the public IP or DDNS
                  hostname below.
                </p>
                <TextField
                  label="Public host/IP for TURN"
                  value={settings.turnPublicHost}
                  onBlur={(v) => save({ turnPublicHost: v })}
                />
                <TextField
                  label="TURN port"
                  value={String(settings.turnPort)}
                  onBlur={(v) => save({ turnPort: Number(v) || 3478 })}
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
              {f.console}: {f.folder_path} → {f.emulator_exe_path}
            </span>
            <button
              onClick={async () => setRomFolders(await api.removeRomFolder(f.id))}
            >
              Remove
            </button>
          </div>
        ))}
        <RomFolderForm
          onAdd={async (body) => setRomFolders(await api.addRomFolder(body))}
        />
      </Section>

      <Section title="Custom apps">
        {customApps.map((a) => (
          <div key={a.id} className="row">
            <span>
              {a.display_name}: {a.exe_path}
            </span>
            <button onClick={async () => setCustomApps(await api.removeCustomApp(a.id))}>
              Remove
            </button>
          </div>
        ))}
        <CustomAppForm onAdd={async (body) => setCustomApps(await api.addCustomApp(body))} />
      </Section>
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
  onBlur,
}: {
  label: string;
  value: string;
  type?: string;
  onBlur: (v: string) => void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <label className="field-row">
      {label}
      <input
        type={type}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => onBlur(local)}
      />
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
      <input
        placeholder="Console (e.g. N64)"
        value={consoleName}
        onChange={(e) => setConsoleName(e.target.value)}
      />
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
