import { useState, type FormEvent } from "react";
import { Box, LoaderCircle, LockKeyhole } from "lucide-react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { ErrorBanner } from "../components/Layout";

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  if (auth.authenticated) return <Navigate to="/" replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await auth.login(password);
      navigate("/");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to sign in");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-glow" />
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="brand-mark large">
            <Box size={26} />
          </span>
          <span>Mineserver</span>
        </div>
        <div>
          <h1>Welcome back</h1>
          <p>Sign in to manage your Minecraft worlds.</p>
        </div>
        {error && <ErrorBanner message={error} />}
        <label>
          Administrator password
          <span className="input-with-icon">
            <LockKeyhole size={17} />
            <input
              autoFocus
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your password"
              autoComplete="current-password"
            />
          </span>
        </label>
        <button className="button primary wide" disabled={loading || !password}>
          {loading && <LoaderCircle className="spin" size={17} />}
          Sign in
        </button>
        <p className="login-footnote">
          Protected by a secure, host-local administrator session.
        </p>
      </form>
    </div>
  );
}
