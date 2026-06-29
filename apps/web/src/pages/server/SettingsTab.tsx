import { useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { ServerConfig, ServerSummary } from "@mineserver/shared";
import { api, jsonBody } from "../../api";
import { ErrorBanner } from "../../components/Layout";
import { ServerForm } from "../../components/ServerForm";

export function SettingsTab({
  server,
  refresh,
}: {
  server: ServerSummary;
  refresh(): Promise<void>;
}) {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [deleteText, setDeleteText] = useState("");
  const [permanent, setPermanent] = useState(false);

  async function save(value: ServerConfig) {
    await api(`/api/servers/${server.id}`, {
      method: "PUT",
      ...jsonBody(value),
    });
    await refresh();
  }

  async function remove() {
    if (deleteText !== server.config.name) return;
    setError("");
    try {
      await api(`/api/servers/${server.id}?permanent=${permanent}`, {
        method: "DELETE",
      });
      navigate("/");
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to delete server",
      );
    }
  }

  return (
    <div className="tab-stack">
      <ServerForm
        initial={server.config}
        submitLabel="Save changes"
        onSubmit={save}
      />
      <section className="danger-zone">
        <div className="danger-title">
          <AlertTriangle size={20} />
          <div>
            <h2>Delete server</h2>
            <p>
              Stops and removes the Compose project. Files are retained unless
              you opt into permanent deletion.
            </p>
          </div>
        </div>
        {error && <ErrorBanner message={error} />}
        <label>
          Type <strong>{server.config.name}</strong> to confirm
          <input
            value={deleteText}
            onChange={(event) => setDeleteText(event.target.value)}
          />
        </label>
        <label className="eula-check">
          <input
            type="checkbox"
            checked={permanent}
            onChange={(event) => setPermanent(event.target.checked)}
          />
          <span>
            Permanently remove world, add-ons, backups, and secrets instead of
            archiving them.
          </span>
        </label>
        <button
          className="button danger"
          disabled={deleteText !== server.config.name}
          onClick={() => void remove()}
        >
          <Trash2 size={17} />{" "}
          {permanent ? "Permanently delete" : "Delete and archive files"}
        </button>
      </section>
    </div>
  );
}
