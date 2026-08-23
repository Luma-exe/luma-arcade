import { useEffect, useState } from "react";
import { api, type AppSettings, type SetupResult, type UpdateStatus } from "../lib/api.js";

export function Settings({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<Partial<AppSettings>>({});
  const [moonlightReachable, setMoonlightReachable] = useState<boolean | null>(null);
  const [checkingMoonlight, setCheckingMoonlight] = useState(false);
  const [runningSetup, setRunningSetup] = useState(false);
  const [setupResult, setSetupResult] = useState<SetupResult | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [applyingUpdate, setApplyingUpdate] = useState(false);
  const [updateLog, setUpdateLog] = useState<string[] | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [confirmingUpdate, setConfirmingUpdate] = useState(false);
  const [updatePassword, setUpdatePassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings().then(setSettings);
    checkMoonlight();
    checkUpdate();
  }, []);

  async function checkMoonlight() {
    setCheckingMoonlight(true);
    try {
      const { reachable } = await api.getMoonlightStatus();
      setMoonlightReachable(reachable);
    } catch {
      setMoonlightReachable(false);
    } finally {
      setCheckingMoonlight(false);
    }
  }

  async function handleRunSetup() {
    setRunningSetup(true);
    setSetupError(null);
    try {
      const result = await api.runSetup();
      setSetupResult(result);
      if (result.moonlightPathUpdated) {
        setSettings(await api.getSettings());
        checkMoonlight();
      }
    } catch (err) {
      setSetupError((err as Error).message);
    } finally {
      setRunningSetup(false);
    }
  }

  async function checkUpdate() {
    setCheckingUpdate(true);
    try {
      setUpdateStatus(await api.checkForUpdate());
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function handleApplyUpdate() {
    // Pulling/rebuilding from devTreePath runs arbitrary package.json
    // scripts — asking for the password again here (same idea as a
    // browser re-prompting for it before a sensitive action) means a
    // stolen session cookie alone isn't enough to trigger it.
    if (!updatePassword) {
      setUpdateError("Password required.");
      return;
    }
    setApplyingUpdate(true);
    setUpdateError(null);
    setUpdateLog(null);
    try {
      const result = await api.applyUpdate(updatePassword);
      setUpdateLog(result.log);
      setConfirmingUpdate(false);
      setUpdatePassword("");
    } catch (err) {
      setUpdateError((err as Error).message);
    } finally {
      setApplyingUpdate(false);
    }
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
      checkMoonlight();
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
          <button onClick={onBack}>Back to Stream</button>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      <Section title="Streaming">
        <p className="muted">
          LumaArcade is now just a login gate in front of your own Sunshine + ES-DE + {" "}
          <a href="https://github.com/MrCreativ3001/moonlight-web-stream" target="_blank" rel="noreferrer">
            moonlight-web-stream
          </a>{" "}
          setup. On the host PC: install Sunshine, add ES-DE as a Sunshine app, then build/install
          moonlight-web-stream and point the fields below at it. LumaArcade will spawn and manage
          that process for you and proxy the browser to it under <code>/stream</code>.
        </p>
        <div className="row">
          <span>
            {checkingMoonlight
              ? "Checking…"
              : moonlightReachable
                ? "✓ moonlight-web-stream is reachable"
                : "✗ moonlight-web-stream is not reachable"}
          </span>
          <button onClick={checkMoonlight} disabled={checkingMoonlight}>
            Recheck
          </button>
        </div>
        <div className="row">
          <span>Auto-detect Sunshine, ES-DE, and moonlight-web-stream on this PC</span>
          <button onClick={handleRunSetup} disabled={runningSetup}>
            {runningSetup ? "Detecting…" : "Detect & wire up dependencies"}
          </button>
        </div>
        {setupError && <p className="error">{setupError}</p>}
        {setupResult && (
          <ul className="muted" style={{ margin: 0, paddingLeft: "1.2rem" }}>
            {setupResult.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        )}
        <p className="muted">
          This wires up what's purely mechanical (adding ES-DE to Sunshine's app list, pointing
          LumaArcade at moonlight-web-stream). Two one-time manual steps it can't do for you: open{" "}
          <a href="https://localhost:47990" target="_blank" rel="noreferrer">
            Sunshine
          </a>{" "}
          once to create its admin account, then pair it from moonlight-web-stream's own UI (open{" "}
          <a href="/stream/" target="_blank" rel="noreferrer">
            /stream/
          </a>{" "}
          directly, add a host, click it, and enter the PIN it shows into Sunshine).
        </p>
        <TextField
          label="moonlight-web-stream executable path"
          value={view.moonlightWebStreamPath}
          onChange={(v) => update({ moonlightWebStreamPath: v })}
        />
        <TextField
          label="Port"
          value={String(view.moonlightWebStreamPort)}
          onChange={(v) => update({ moonlightWebStreamPort: Number(v) || 8080 })}
        />
        <Toggle
          label="Have LumaArcade start it automatically"
          checked={view.moonlightAutoStart}
          onChange={(v) => update({ moonlightAutoStart: v })}
        />
        <p className="muted">Path/port changes take effect after restarting LumaArcade.</p>
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
        {updateStatus?.updateAvailable && !confirmingUpdate && (
          <button onClick={() => setConfirmingUpdate(true)} disabled={!view.devTreePath}>
            Apply update
          </button>
        )}
        {confirmingUpdate && (
          <div className="input-row">
            <TextField
              label="Confirm your password to apply this update"
              type="password"
              value={updatePassword}
              onChange={setUpdatePassword}
            />
            <button onClick={handleApplyUpdate} disabled={applyingUpdate || !updatePassword}>
              {applyingUpdate ? "Updating…" : "Confirm"}
            </button>
            <button
              onClick={() => {
                setConfirmingUpdate(false);
                setUpdatePassword("");
                setUpdateError(null);
              }}
              disabled={applyingUpdate}
            >
              Cancel
            </button>
          </div>
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
