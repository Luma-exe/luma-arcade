import { useEffect, useState } from "react";

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [passwordSet, setPasswordSet] = useState<boolean | null>(null);
  const [canSetPassword, setCanSetPassword] = useState(true);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/auth/status")
      .then((res) => res.json())
      .then((data) => {
        setPasswordSet(data.passwordSet);
        setCanSetPassword(data.canSetPassword ?? true);
      })
      .catch(() => setPasswordSet(false));
  }, []);

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    const res = await fetch("/api/auth/set-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setSubmitting(false);
    if (res.ok) onLoggedIn();
    else setError((await res.json()).error ?? "Failed to set password.");
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setSubmitting(false);
    if (res.ok) onLoggedIn();
    else setError((await res.json()).error ?? "Login failed.");
  }

  if (passwordSet === null) return <div className="center login-page">Loading…</div>;

  if (!passwordSet && !canSetPassword) {
    return (
      <div className="center login-page">
        <div className="auth-card">
          <div className="brand-pill">
            <span className="brand-pill-dot" />
            Luma Arcade
          </div>
          <h1>Not set up yet</h1>
          <p className="muted">
            For security, the portal password can only be set from the home network. Open
            LumaArcade on the host PC or another device at home to finish setup.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="center login-page">
      <form className="auth-card" onSubmit={passwordSet ? handleLogin : handleSetPassword}>
        <div className="brand-pill">
          <span className="brand-pill-dot" />
          Luma Arcade
        </div>
        <h1>{passwordSet ? "Welcome back" : "Set up LumaArcade"}</h1>
        <p className="muted">
          {passwordSet ? "Enter the portal password." : "Choose a password to protect this portal."}
        </p>
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        {!passwordSet && (
          <input
            type="password"
            placeholder="Confirm password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        )}
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={submitting}>
          {passwordSet ? "Log in" : "Set password"}
        </button>
      </form>
    </div>
  );
}
