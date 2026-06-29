import { useCallback, useEffect, useRef, useState } from "react";
import {
  FileArchive,
  FileUp,
  LoaderCircle,
  PackageOpen,
  Power,
  Trash2,
} from "lucide-react";
import type { AddonFile, ServerSummary } from "@mineserver/shared";
import { api, formatBytes, jsonBody } from "../../api";
import { EmptyState, ErrorBanner } from "../../components/Layout";

export function AddonsTab({ server }: { server: ServerSummary }) {
  const [kind, setKind] = useState<"mods" | "plugins" | null>(null);
  const [files, setFiles] = useState<AddonFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    try {
      const response = await api<{
        kind: "mods" | "plugins" | null;
        files: AddonFile[];
      }>(`/api/servers/${server.id}/addons`);
      setKind(response.kind);
      setFiles(response.files);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to load add-ons",
      );
    } finally {
      setLoading(false);
    }
  }, [server.id]);
  useEffect(() => void load(), [load]);

  async function upload(file: File) {
    setUploading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      await api(`/api/servers/${server.id}/addons`, {
        method: "POST",
        body: form,
      });
      await load();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Upload failed");
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  }

  async function toggle(file: AddonFile) {
    try {
      await api(
        `/api/servers/${server.id}/addons/${encodeURIComponent(file.name)}`,
        {
          method: "PATCH",
          ...jsonBody({ enabled: !file.enabled }),
        },
      );
      await load();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to update add-on",
      );
    }
  }

  async function remove(file: AddonFile) {
    if (
      !confirm(
        `Delete ${file.name}? The server must be restarted for this to take effect.`,
      )
    )
      return;
    try {
      await api(
        `/api/servers/${server.id}/addons/${encodeURIComponent(file.name)}`,
        {
          method: "DELETE",
        },
      );
      await load();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to delete add-on",
      );
    }
  }

  if (!loading && !kind) {
    return (
      <EmptyState
        icon={<PackageOpen size={28} />}
        title="No managed add-ons for this type"
        body="Choose Paper for plugins, or Fabric, Forge, or NeoForge for mods."
      />
    );
  }
  return (
    <div className="tab-stack">
      {error && <ErrorBanner message={error} />}
      <div className="panel upload-panel">
        <div>
          <h2>{kind === "plugins" ? "Plugins" : "Mods"}</h2>
          <p>
            Upload one JAR or a ZIP containing only JAR files. Changes apply
            after restart.
          </p>
        </div>
        <input
          ref={input}
          hidden
          type="file"
          accept=".jar,.zip"
          onChange={(event) =>
            event.target.files?.[0] && void upload(event.target.files[0])
          }
        />
        <button
          className="button primary"
          disabled={uploading}
          onClick={() => input.current?.click()}
        >
          {uploading ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <FileUp size={17} />
          )}
          Upload JAR or ZIP
        </button>
      </div>
      <div className="panel file-panel">
        {files.length === 0 ? (
          <div className="compact-empty">
            <FileArchive size={26} />
            <strong>No {kind} uploaded</strong>
            <span>
              Your server can run without them. Add one whenever you are ready.
            </span>
          </div>
        ) : (
          <div className="file-list">
            {files.map((file) => (
              <div
                className={`file-row ${file.enabled ? "" : "disabled"}`}
                key={file.name}
              >
                <span className="file-icon">
                  <FileArchive size={18} />
                </span>
                <div>
                  <strong>{file.name}</strong>
                  <small>
                    {formatBytes(file.size)} ·{" "}
                    {new Date(file.modifiedAt).toLocaleString()}
                  </small>
                </div>
                <span
                  className={file.enabled ? "enabled-pill" : "disabled-pill"}
                >
                  {file.enabled ? "Enabled" : "Disabled"}
                </span>
                <button
                  className="icon-button"
                  title={file.enabled ? "Disable" : "Enable"}
                  onClick={() => void toggle(file)}
                >
                  <Power size={17} />
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
