import { useEffect, useState } from "react";
import {
  Activity,
  CircleStop,
  Cpu,
  Download,
  HardDrive,
  LoaderCircle,
  Play,
  RefreshCcw,
  RotateCw,
  Users,
} from "lucide-react";
import type { Operation, ServerStats, ServerSummary } from "@mineserver/shared";
import { api } from "../../api";
import { ErrorBanner } from "../../components/Layout";

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
      {error && <ErrorBanner message={error} />}
      <div className="action-bar panel">
        <div>
          <h2>Power controls</h2>
          <p>
            Commands are queued and run through this server’s Compose project.
          </p>
        </div>
        <div className="button-row">
          {server.state === "running" ? (
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
                {server.restartRequired ? "Apply & restart" : "Restart"}
              </button>
            </>
          ) : (
            <button
              className="button primary"
              disabled={!!busy}
              onClick={() => void action("start")}
            >
              {busy === "start" ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <Play size={17} />
              )}
              Start server
            </button>
          )}
          {server.restartRequired && server.state !== "running" && (
            <button
              className="button primary"
              disabled={!!busy}
              onClick={() => void action("apply")}
            >
              <RefreshCcw size={17} /> Apply changes
            </button>
          )}
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
            <strong>{server.health || server.state}</strong>
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
                <small>{operation.message || operation.status}</small>
              </div>
              <time>{new Date(operation.updatedAt).toLocaleString()}</time>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
