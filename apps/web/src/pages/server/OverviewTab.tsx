import { useEffect, useState } from "react";
import {
  Activity,
  CircleStop,
  Cpu,
  Download,
  HardDrive,
  Hammer,
  LoaderCircle,
  Play,
  RotateCw,
  Users,
} from "lucide-react";
import type { Operation, ServerStats, ServerSummary } from "@mineserver/shared";
import { api } from "../../api";
import { ConfirmationDialog, ErrorBanner } from "../../components/Layout";

export function OverviewTab({
  server,
  refresh,
}: {
  server: ServerSummary;
  refresh(): Promise<void>;
}) {
  const [stats, setStats] = useState<ServerStats | null>(null);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirmRebuild, setConfirmRebuild] = useState(false);

  useEffect(() => {
    if (server.state !== "running") {
      setStats(null);
      return;
    }
    const load = () =>
      api<ServerStats>(`/api/servers/${server.id}/stats`)
        .then(setStats)
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [server.id, server.state]);

  useEffect(() => {
    const load = () =>
      api<Operation[]>(`/api/servers/${server.id}/operations`)
        .then(setOperations)
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [server.id]);

  async function action(name: string) {
    setBusy(name);
    setError("");
    try {
      await api(`/api/servers/${server.id}/actions/${name}`, {
        method: "POST",
      });
      window.setTimeout(() => void refresh(), 1500);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Operation failed");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="tab-stack">
      <ConfirmationDialog
        open={confirmRebuild}
        title="Rebuild this container?"
        body="The current container will be removed and recreated from the current local image. Server data is preserved, and all pending configuration changes will be applied."
        confirmLabel="Rebuild container"
        onCancel={() => setConfirmRebuild(false)}
        onConfirm={() => {
          setConfirmRebuild(false);
          void action("rebuild");
        }}
      />
      {error && <ErrorBanner message={error} />}
      <div className="action-bar panel">
        <div>
          <h2>Power controls</h2>
          <p>
            {server.config.autoSleep.enabled && !server.wakeProxyRunning
              ? "Wake-on-join is configured, but its listener is stopped. Run the server to activate it."
              : server.config.autoSleep.enabled
                ? `Wake-on-join is enabled; the game container sleeps after ${server.config.autoSleep.idleMinutes} empty minute${server.config.autoSleep.idleMinutes === 1 ? "" : "s"}.`
                : "Commands are queued and run through this server’s Compose project."}
          </p>
        </div>
        <div className="button-row">
          {server.state !== "stopped" && server.containerExists ? (
            <>
              <button
                className="button ghost"
                disabled={!!busy}
                onClick={() => void action("stop")}
              >
                {busy === "stop" ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <CircleStop size={17} />
                )}
                Stop
              </button>
              {(server.state === "running" || server.state === "unhealthy") && (
                <button
                  className="button ghost"
                  disabled={!!busy}
                  onClick={() => void action("restart")}
                >
                  {busy === "restart" ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : (
                    <RotateCw size={17} />
                  )}
                  Restart
                </button>
              )}
            </>
          ) : (
            <button
              className="button primary"
              disabled={!!busy}
              onClick={() => void action("run")}
            >
              {busy === "run" ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <Play size={17} />
              )}
              Run server
            </button>
          )}
          <button
            className="button danger-outline"
            disabled={!!busy}
            onClick={() => setConfirmRebuild(true)}
          >
            {busy === "rebuild" ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <Hammer size={17} />
            )}
            Rebuild
          </button>
          <button
            className="button ghost"
            disabled={!!busy}
            onClick={() => void action("pull")}
          >
            <Download size={17} /> Pull images
          </button>
        </div>
      </div>

      <div className="metric-grid">
        <div className="metric-card">
          <span className="metric-icon green">
            <Activity size={19} />
          </span>
          <div>
            <small>Status</small>
            <strong>
              {server.state === "stopped" && server.wakeProxyRunning
                ? "sleeping"
                : server.health || server.state}
            </strong>
          </div>
        </div>
        <div className="metric-card">
          <span className="metric-icon amber">
            <Cpu size={19} />
          </span>
          <div>
            <small>CPU</small>
            <strong>
              {stats?.cpuPercent != null ? `${stats.cpuPercent}%` : "—"}
            </strong>
          </div>
        </div>
        <div className="metric-card">
          <span className="metric-icon blue">
            <HardDrive size={19} />
          </span>
          <div>
            <small>Memory</small>
            <strong>{stats?.memoryUsage ?? server.config.maxMemory}</strong>
          </div>
        </div>
        <div className="metric-card">
          <span className="metric-icon purple">
            <Users size={19} />
          </span>
          <div>
            <small>Players</small>
            <strong>
              {stats?.players?.match(/There are (\d+)/)?.[1] ?? "—"}
            </strong>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-heading">
          <div>
            <h2>Recent operations</h2>
            <p>Lifecycle, backup, and restore activity.</p>
          </div>
        </div>
        <div className="operation-list">
          {operations.length === 0 && (
            <p className="muted">No operations yet.</p>
          )}
          {operations.slice(0, 8).map((operation) => (
            <div className="operation-row" key={operation.id}>
              <span className={`operation-icon ${operation.status}`}>
                {operation.status === "running" ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <span />
                )}
              </span>
              <div>
                <strong>{operation.kind}</strong>
                <small>
                  {operation.status === "failed"
                    ? "Failed — error log available"
                    : operation.message || operation.status}
                </small>
                {operation.status === "failed" && operation.message && (
                  <details className="operation-error">
                    <summary>View error log</summary>
                    <pre>{operation.message}</pre>
                  </details>
                )}
              </div>
              <time>{new Date(operation.updatedAt).toLocaleString()}</time>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
