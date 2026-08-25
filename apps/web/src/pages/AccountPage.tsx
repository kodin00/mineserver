import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  KeyRound,
  LoaderCircle,
  PackageSearch,
  ShieldCheck,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import type { MarketplaceSettings } from "@mineserver/shared";
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
      title="Settings"
      subtitle="Administrator password and mod marketplace access for this panel."
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
      <MarketplaceSettingsCard />
    </Layout>
  );
}

function MarketplaceSettingsCard() {
  const [settings, setSettings] = useState<MarketplaceSettings | null>(null);
  const [contact, setContact] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const load = useCallback(async () => {
    try {
      const current = await api<MarketplaceSettings>(
        "/api/settings/marketplace",
      );
      setSettings(current);
      setEnabled(current.enabled);
      setContact(current.contact);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to load marketplace settings",
      );
    }
  }, []);

  useEffect(() => void load(), [load]);

  async function save(clearingToken: boolean) {
    setSaving(true);
    setError("");
    setSaved("");
    try {
      const next = await api<MarketplaceSettings>("/api/settings/marketplace", {
        method: "PUT",
        // An untouched token field is omitted entirely, so editing any other
        // setting cannot wipe a stored token.
        ...jsonBody({
          enabled,
          contact,
          ...(clearingToken
            ? { token: null }
            : token.trim()
              ? { token: token.trim() }
              : {}),
        }),
      });
      setSettings(next);
      setToken("");
      setSaved(
        clearingToken
          ? "Access token removed."
          : next.tokenStatus === "invalid"
            ? "Settings saved, but Modrinth rejected that token."
            : next.tokenStatus === "valid"
              ? "Settings saved. The token authenticated successfully."
              : next.tokenStatus === "unreachable"
                ? "Settings saved, but the token could not be checked right now."
                : "Marketplace settings saved.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to save settings",
      );
    } finally {
      setSaving(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await save(false);
  }

  return (
    <form className="account-card panel" onSubmit={submit}>
      <div className="account-icon">
        <PackageSearch size={23} />
      </div>
      <div>
        <h2>Mod marketplace</h2>
        <p>
          Browsing and installing from Modrinth needs no account, so everything
          here is optional.
        </p>
      </div>

      {error && <ErrorBanner message={error} />}
      {saved && <p className="notice-banner">{saved}</p>}

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        Enable the marketplace. Turn it off for an air-gapped panel and nothing
        will contact Modrinth.
      </label>

      <label>
        Contact details (optional)
        <input
          value={contact}
          placeholder="you@example.com"
          maxLength={120}
          onChange={(event) => setContact(event.target.value)}
        />
        <small className="muted">
          Sent in the User-Agent so Modrinth can reach you about API usage
          instead of silently blocking this panel.
        </small>
      </label>

      <label>
        Modrinth access token (optional)
        <input
          type="password"
          value={token}
          autoComplete="off"
          placeholder={
            settings?.hasToken ? "A token is stored" : "Not set — not required"
          }
          maxLength={256}
          onChange={(event) => setToken(event.target.value)}
        />
        <small className="muted">
          Only needed to reach projects that are private to your own Modrinth
          account. A token does not raise the rate limit. Leave this blank to
          keep the stored value unchanged.
        </small>
      </label>

      {settings && (
        <p className="muted settings-summary">
          <ShieldCheck size={14} /> Sending <code>{settings.userAgent}</code>
          {settings.hasToken ? " with a stored token." : " with no token."}
        </p>
      )}

      <div className="button-row">
        <button className="button primary" disabled={saving}>
          {saving && <LoaderCircle className="spin" size={17} />} Save
        </button>
        {settings?.hasToken && (
          <button
            type="button"
            className="button danger-outline"
            disabled={saving}
            onClick={() => void save(true)}
          >
            Remove token
          </button>
        )}
      </div>
    </form>
  );
}
