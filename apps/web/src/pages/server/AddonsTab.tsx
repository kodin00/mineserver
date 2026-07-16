import {
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Archive,
  Check,
  Copy,
  Download,
  FileArchive,
  FileUp,
  LoaderCircle,
  PackageOpen,
  Power,
  Share2,
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
  const [uploadCount, setUploadCount] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareLink, setShareLink] = useState<{
    url: string;
    expiresAt: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [sort, setSort] = useState<"alphabetical" | "newest">("alphabetical");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const uploadInFlight = useRef(false);
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
  const sortedFiles = useMemo(
    () =>
      [...files].sort((a, b) =>
        sort === "alphabetical"
          ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
          : b.modifiedAt.localeCompare(a.modifiedAt),
      ),
    [files, sort],
  );

  async function upload(selectedFiles: File[]) {
    if (selectedFiles.length === 0) return;
    if (uploadInFlight.current) {
      setError("Wait for the current upload to finish.");
      return;
    }
    const invalid = selectedFiles.find(
      (file) => !/\.(?:jar|zip)$/i.test(file.name),
    );
    if (invalid) {
      setError(`Only JAR and ZIP files are accepted: ${invalid.name}`);
      return;
    }
    uploadInFlight.current = true;
    setUploading(true);
    setUploadCount(selectedFiles.length);
    setError("");
    try {
      const form = new FormData();
      for (const file of selectedFiles) form.append("file", file);
      await api(`/api/servers/${server.id}/addons`, {
        method: "POST",
        body: form,
      });
      await load();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Upload failed");
    } finally {
      uploadInFlight.current = false;
      setUploading(false);
      setUploadCount(0);
      if (input.current) input.current.value = "";
    }
  }

  function isFileDrag(event: DragEvent<HTMLDivElement>) {
    return event.dataTransfer.types.includes("Files");
  }

  function dragEnter(event: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    setDragging(true);
  }

  function dragOver(event: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function dragLeave(event: DragEvent<HTMLDivElement>) {
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    )
      return;
    setDragging(false);
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    setDragging(false);
    void upload(Array.from(event.dataTransfer.files));
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

  async function createShareLink() {
    setSharing(true);
    setError("");
    setCopied(false);
    try {
      const response = await api<{ path: string; expiresAt: string }>(
        `/api/servers/${server.id}/addons/share`,
        { method: "POST" },
      );
      const url = new URL(response.path, window.location.origin).toString();
      setShareLink({ url, expiresAt: response.expiresAt });
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
      } catch {
        // The URL remains visible when clipboard permission is unavailable.
      }
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to create share link",
      );
    } finally {
      setSharing(false);
    }
  }

  async function copyShareLink() {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink.url);
      setCopied(true);
    } catch {
      setError("Clipboard access was denied. Copy the link manually.");
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
    <div
      className={`tab-stack addon-drop-surface ${dragging ? "is-dragging" : ""}`}
      aria-busy={uploading}
      onDragEnter={dragEnter}
      onDragOver={dragOver}
      onDragLeave={dragLeave}
      onDrop={drop}
    >
      {error && <ErrorBanner message={error} />}
      <div className="panel upload-panel addon-upload-panel">
        <div>
          <h2>{kind === "plugins" ? "Plugins" : "Mods"}</h2>
          <p>
            Drop JARs or ZIPs here, or choose multiple files. Changes apply
            after restart.
          </p>
        </div>
        <div className="addon-actions">
          <label>
            <span className="sr-only">Sort add-ons</span>
            <select
              value={sort}
              onChange={(event) =>
                setSort(event.target.value as "alphabetical" | "newest")
              }
              aria-label="Sort add-ons"
            >
              <option value="alphabetical">Alphabetical</option>
              <option value="newest">Date added</option>
            </select>
          </label>
          {files.length > 0 && (
            <>
              <a
                className="button ghost"
                href={`/api/servers/${server.id}/addons/download-all`}
              >
                <Archive size={17} /> Download all
              </a>
              <button
                className="button ghost"
                disabled={sharing}
                onClick={() => void createShareLink()}
              >
                {sharing ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <Share2 size={17} />
                )}
                Share once
              </button>
            </>
          )}
          <input
            ref={input}
            hidden
            type="file"
            multiple
            accept=".jar,.zip"
            onChange={(event) =>
              event.target.files && void upload(Array.from(event.target.files))
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
            {uploading
              ? `Uploading ${uploadCount} file${uploadCount === 1 ? "" : "s"}`
              : "Choose JARs or ZIPs"}
          </button>
          {dragging && (
            <div className="addon-drop-overlay" role="status">
              <FileUp size={24} />
              <strong>Drop files to install</strong>
              <span>JAR and ZIP files can be mixed</span>
            </div>
          )}
        </div>
      </div>
      {shareLink && (
        <div className="panel share-link-panel" role="status">
          <div>
            <strong>One-time public download link</strong>
            <p>
              The first download invalidates this URL immediately. If unused, it
              expires {new Date(shareLink.expiresAt).toLocaleString()}.
            </p>
          </div>
          <div className="share-link-row">
            <input
              aria-label="One-time public download link"
              readOnly
              value={shareLink.url}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              className="button primary"
              onClick={() => void copyShareLink()}
            >
              {copied ? <Check size={17} /> : <Copy size={17} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
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
            {sortedFiles.map((file) => (
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
                <a
                  className="icon-button"
                  title={`Download ${file.name}`}
                  href={`/api/servers/${server.id}/addons/${encodeURIComponent(file.name)}/download`}
                >
                  <Download size={17} />
                </a>
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
