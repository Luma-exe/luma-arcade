import { useEffect, useState } from "react";

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [passwordSet, setPasswordSet] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/auth/status")
      .then((res) => res.json())
      .then((data) => setPasswordSet(data.passwordSet))
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

  if (passwordSet === null) return <div className="center">Loading…</div>;

  return (
    <div className="center">
      <form className="auth-card" onSubmit={passwordSet ? handleLogin : handleSetPassword}>
        <h1>LumaArcade</h1>
        <p>{passwordSet ? "Enter the portal password." : "Set a password to protect this portal."}</p>
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
