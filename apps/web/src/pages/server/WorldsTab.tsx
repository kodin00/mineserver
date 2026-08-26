import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  ArchiveRestore,
  Download,
  Globe2,
  LoaderCircle,
  Upload,
} from "lucide-react";
import type { Operation, ServerSummary, WorldInfo } from "@mineserver/shared";
import { api, formatBytes } from "../../api";
import { ConfirmationDialog, ErrorBanner } from "../../components/Layout";

export function WorldsTab({
  server,
  refreshServer,
}: {
  server: ServerSummary;
  refreshServer(): Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [world, setWorld] = useState<WorldInfo | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setWorld(await api<WorldInfo>(`/api/servers/${server.id}/world`));
      setError("");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to load world",
      );
    }
  }, [server.id]);

  useEffect(() => {
    void load();
  }, [load, server.state]);

  useEffect(() => {
    if (
      !operation ||
      operation.status === "succeeded" ||
      operation.status === "failed"
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void api<Operation[]>(`/api/servers/${server.id}/operations`)
        .then((items) => {
          const next = items.find((item) => item.id === operation.id);
          if (next) setOperation(next);
        })
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [operation, server.id]);

  useEffect(() => {
    if (operation?.status === "succeeded") {
      setMessage(operation.message ?? "World imported.");
      setFile(null);
      setOperation(null);
      void load();
      void refreshServer();
    } else if (operation?.status === "failed") {
      setError(operation.message ?? "World import failed");
      setOperation(null);
    }
  }, [operation, load, refreshServer]);

  function choose(candidate: File | null) {
    setError("");
    setMessage("");
    if (!candidate) return;
    if (!candidate.name.toLowerCase().endsWith(".zip")) {
      setFile(null);
      setError("Choose a ZIP world archive.");
      return;
    }
    setFile(candidate);
  }

  function drop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragging(false);
    choose(event.dataTransfer.files.item(0));
  }

  async function exportWorld() {
    setExporting(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/servers/${server.id}/world/export`, {
        credentials: "same-origin",
      });
      if (!response.ok) {
        const body = await response
          .json()
          .catch(() => ({ error: response.statusText }));
        throw new Error(body.error ?? response.statusText);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const disposition = response.headers.get("content-disposition") ?? "";
      const match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
      link.href = url;
      link.download = match
        ? decodeURIComponent(match[1]!)
        : `${world?.levelName ?? "world"}.zip`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage("World export downloaded.");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to export world",
      );
    } finally {
      setExporting(false);
    }
  }

  async function importSelected() {
    if (!file || !world) return;
    setConfirming(false);
    setError("");
    setMessage("");
    const body = new FormData();
    body.append("world", file);
    body.append("acknowledgeLevelName", world.levelName);
    body.append("overwrite", "true");
    try {
      setOperation(
        await api<Operation>(`/api/servers/${server.id}/world/import`, {
          method: "POST",
          body,
        }),
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to import world",
      );
    }
  }

  const busy = exporting || operation !== null;
  const stopped = server.state === "stopped" && world?.canImport === true;

  return (
    <div className="tab-stack">
      {error && <ErrorBanner message={error} />}
      {message && (
        <p className="notice-banner" role="status">
          {message}
        </p>
      )}

      <section className="panel world-summary">
        <span className="world-icon">
          <Globe2 size={24} />
        </span>
        <div>
          <h2>Active world</h2>
          <strong>
            <code>{world?.levelName ?? "Loading…"}</code>
          </strong>
          <p>
            {world?.exists
              ? `${world.size === null ? "Unknown size" : formatBytes(world.size)}${world.modifiedAt ? ` · last changed ${new Date(world.modifiedAt).toLocaleString()}` : ""}`
              : "This world has not been created on disk yet."}
          </p>
        </div>
        <button
          className="button ghost"
          disabled={
            busy ||
            !world?.exists ||
            !["running", "stopped"].includes(server.state)
          }
          onClick={() => void exportWorld()}
        >
          {exporting ? (
            <LoaderCircle className="spin" size={17} />
          ) : (
            <Download size={17} />
          )}
          Export world
        </button>
      </section>

      <section className="panel world-import-panel">
        <div>
          <h2>Replace active world</h2>
          <p>
            Import a standalone world ZIP containing <code>level.dat</code> at
            the archive root or inside one wrapper folder. This replaces only{" "}
            <code>{world?.levelName ?? "the active world"}</code>, not other
            server data.
          </p>
        </div>
        {!stopped && (
          <p className="notice-banner">
            Stop the server before importing. It will remain stopped after the
            world is replaced.
          </p>
        )}
        <input
          ref={inputRef}
          className="sr-only"
          type="file"
          accept=".zip,application/zip"
          onChange={(event) => choose(event.target.files?.item(0) ?? null)}
        />
        <button
          type="button"
          className={`world-drop-zone${dragging ? " dragging" : ""}`}
          disabled={busy || !stopped}
          onClick={() => inputRef.current?.click()}
          onDragEnter={(event) => {
            event.preventDefault();
            if (!busy && stopped) setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
        >
          <Upload size={25} />
          <strong>{file ? file.name : "Choose or drop a world ZIP"}</strong>
          <span>
            {file
              ? formatBytes(file.size)
              : "The archive is checked before any world is replaced."}
          </span>
        </button>
        <div className="world-import-actions">
          {file && (
            <button
              className="button ghost"
              disabled={busy}
              onClick={() => setFile(null)}
            >
              Clear
            </button>
          )}
          <button
            className="button danger"
            disabled={!file || !stopped || busy}
            onClick={() => setConfirming(true)}
          >
            {operation ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <ArchiveRestore size={17} />
            )}
            {operation ? "Importing…" : "Replace active world"}
          </button>
        </div>
      </section>

      <ConfirmationDialog
        open={confirming}
        title={`Replace ${world?.levelName ?? "active world"}?`}
        body={`This permanently replaces the current ${world?.levelName ?? "active"} world with ${file?.name ?? "the selected ZIP"}. Full-server backups are separate and are not created by this import. The server will remain stopped.`}
        confirmLabel="Replace world"
        onCancel={() => setConfirming(false)}
        onConfirm={() => void importSelected()}
      />
    </div>
  );
}
