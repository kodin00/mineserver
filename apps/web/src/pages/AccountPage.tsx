import { useState, type FormEvent } from "react";
import { ArrowLeft, KeyRound, LoaderCircle } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { api, jsonBody } from "../api";
import { useAuth } from "../auth";
import { ErrorBanner, Layout } from "../components/Layout";

export function AccountPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) {
      setError("New passwords do not match");
      return;
    }
    setSaving(true);
    try {
      await api("/api/auth/password", {
        method: "POST",
        ...jsonBody({ currentPassword, newPassword }),
      });
      await auth.logout();
      navigate("/login");
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to change password",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Layout
      title="Account security"
      subtitle="Changing the administrator password signs out every active session."
      actions={
        <Link className="button ghost" to="/">
          <ArrowLeft size={17} /> Back
        </Link>
      }
    >
      <form className="account-card panel" onSubmit={submit}>
        <div className="account-icon">
          <KeyRound size={23} />
        </div>
        <div>
          <h2>Change administrator password</h2>
          <p>
            Use at least 12 characters and keep it outside this server’s
            repository.
          </p>
        </div>
        {error && <ErrorBanner message={error} />}
        <label>
          Current password
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </label>
        <label>
          New password
          <input
            type="password"
            minLength={12}
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </label>
        <label>
          Confirm new password
          <input
            type="password"
            minLength={12}
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </label>
        <button
          className="button primary"
          disabled={saving || !currentPassword || newPassword.length < 12}
        >
          {saving && <LoaderCircle className="spin" size={17} />} Update
          password
        </button>
      </form>
    </Layout>
  );
}
