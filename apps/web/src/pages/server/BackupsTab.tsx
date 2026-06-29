import { useCallback, useEffect, useState } from "react";
import {
  Archive,
  Download,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { BackupFile, ServerSummary } from "@mineserver/shared";
import { api, formatBytes } from "../../api";
import { ErrorBanner } from "../../components/Layout";

export function BackupsTab({
  server,
  refreshServer,
}: {
  server: ServerSummary;
  refreshServer(): Promise<void>;
}) {
  const [files, setFiles] = useState<BackupFile[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setFiles(await api<BackupFile[]>(`/api/servers/${server.id}/backups`));
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to load backups",
      );
    }
  }, [server.id]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  async function backup() {
    setBusy("backup");
    setError("");
    try {
      await api(`/api/servers/${server.id}/actions/backup`, { method: "POST" });
      window.setTimeout(() => void load(), 2500);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to start backup",
      );
    } finally {
      setBusy("");
    }
  }

  async function restore(file: BackupFile) {
    if (server.state !== "stopped") {
      setError("Stop the server before restoring a backup.");
      return;
    }
    if (
      !confirm(
        `Restore ${file.name}? A safety snapshot is created first, then the server is started and checked.`,
      )
    )
      return;
    setBusy(file.name);
    setError("");
    try {
      await api(
        `/api/servers/${server.id}/backups/${encodeURIComponent(file.name)}/restore`,
        {
          method: "POST",
        },
      );
      window.setTimeout(() => void refreshServer(), 2500);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to start restore",
      );
    } finally {
      setBusy("");
    }
  }

  async function remove(file: BackupFile) {
    if (!confirm(`Permanently delete ${file.name}?`)) return;
    try {
      await api(
        `/api/servers/${server.id}/backups/${encodeURIComponent(file.name)}`,
        {
          method: "DELETE",
        },
      );
      await load();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to delete backup",
      );
    }
  }

  return (
    <div className="tab-stack">
      {error && <ErrorBanner message={error} />}
      <div className="panel action-bar">
        <div>
          <h2>World protection</h2>
          <p>
            Scheduled at <code>{server.config.backups.cron}</code> · keeping{" "}
            {server.config.backups.retainCount} files for up to{" "}
            {server.config.backups.retainDays} days.
          </p>
        </div>
        <button
          className="button primary"
          disabled={!!busy || server.state !== "running"}
          onClick={() => void backup()}
        >
          {busy === "backup" ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <ShieldCheck size={17} />
          )}
          Back up now
        </button>
      </div>
      <div className="panel file-panel">
        {files.length === 0 ? (
          <div className="compact-empty">
            <Archive size={26} />
            <strong>No backups yet</strong>
            <span>Start the server, then make your first safe snapshot.</span>
          </div>
        ) : (
          <div className="file-list">
            {files.map((file) => (
              <div className="file-row backup-row" key={file.name}>
                <span className="file-icon">
                  <Archive size={18} />
                </span>
                <div>
                  <strong>{file.name}</strong>
                  <small>
                    {formatBytes(file.size)} ·{" "}
                    {new Date(file.createdAt).toLocaleString()}
                  </small>
                </div>
                <a
                  className="icon-button"
                  title="Download"
                  href={`/api/servers/${server.id}/backups/${encodeURIComponent(file.name)}/download`}
                >
                  <Download size={17} />
                </a>
                <button
                  className="icon-button"
                  title="Restore"
                  disabled={!!busy || server.state !== "stopped"}
                  onClick={() => void restore(file)}
                >
                  {busy === file.name ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : (
                    <RotateCcw size={17} />
                  )}
                </button>
                <button
                  className="icon-button danger-icon"
                  title="Delete"
                  onClick={() => void remove(file)}
                >
                  <Trash2 size={17} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
