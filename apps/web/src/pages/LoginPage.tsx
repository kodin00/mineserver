import { useState, type FormEvent } from "react";
import { Box, LoaderCircle, LockKeyhole } from "lucide-react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { Select } from "../components/ChoiceControls";
import { ErrorBanner } from "../components/Layout";

export function LoginPage() {
  const demo = import.meta.env.VITE_DEMO === "true";
  const auth = useAuth();
  const navigate = useNavigate();
  const [role, setRole] = useState<"admin" | "player">("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  if (auth.authenticated) return <Navigate to="/" replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await auth.login(demo ? "demo" : password, role);
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
          <p>
            {demo
              ? "Explore sample servers as an administrator or player. No password needed."
              : "Sign in to your Minecraft server panel."}
          </p>
        </div>
        {error && <ErrorBanner message={error} />}
        <label>
          Sign in as
          <Select<"admin" | "player">
            value={role}
            ariaLabel="Sign in as"
            options={[
              { value: "admin", label: "Administrator" },
              { value: "player", label: "Player" },
            ]}
            onChange={setRole}
          />
        </label>
        {!demo && (
          <label>
            {role === "admin" ? "Administrator" : "Player"} password
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
        )}
        <button
          className="button primary wide"
          disabled={loading || (!demo && !password)}
        >
          {loading && <LoaderCircle className="spin" size={17} />}
          {demo ? "Explore demo" : "Sign in"}
        </button>
        {!demo && role === "admin" && (
          <p className="login-default-password">
            Default password: <code>mineserver123!</code>. To use a different
            password, set <code>ADMIN_PASSWORD</code> in <code>.env</code>{" "}
            before the first start.
          </p>
        )}
        <p className="login-footnote">
          Protected by a secure, host-local session.
        </p>
      </form>
    </div>
  );
}
