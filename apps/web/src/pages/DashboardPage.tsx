import { useCallback, useEffect, useState } from "react";
import {
  Box,
  ChevronRight,
  CirclePlus,
  Cpu,
  HardDrive,
  RefreshCw,
  TriangleAlert,
  Users,
} from "lucide-react";
import { Link } from "react-router-dom";
import type { ServerSummary } from "@mineserver/shared";
import { api } from "../api";
import {
  EmptyState,
  ErrorBanner,
  Layout,
  StatusDot,
} from "../components/Layout";

export function DashboardPage() {
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setServers(await api<ServerSummary[]>("/api/servers"));
      setError("");
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to load servers",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const running = servers.filter((server) => server.state === "running").length;
  return (
    <Layout
      title="Your servers"
      subtitle={`${running} running · ${servers.length} total`}
      actions={
        <>
          <button
            className="button ghost"
            onClick={() => void load()}
            aria-label="Refresh"
          >
            <RefreshCw size={17} /> Refresh
          </button>
          <Link className="button primary" to="/servers/new">
            <CirclePlus size={17} /> New server
          </Link>
        </>
      }
    >
      {error && <ErrorBanner message={error} />}
      {!loading && servers.length === 0 ? (
        <EmptyState
          icon={<Box size={28} />}
          title="Build your first world"
          body="Create an isolated Minecraft server with its own version, port, memory, add-ons, and backups."
          action={
            <Link className="button primary" to="/servers/new">
              <CirclePlus size={17} /> Create server
            </Link>
          }
        />
      ) : (
        <div className="server-grid">
          {servers.map((server) => (
            <Link
              to={`/servers/${server.id}`}
              className={`server-card ${server.runtimeError || server.state === "unhealthy" ? "has-error" : ""}`}
              key={server.id}
            >
              <div className="card-top">
                <div className="server-avatar">
                  {server.config.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="server-title">
                  <h2>{server.config.name}</h2>
                  <span className={`status-label status-${server.state}`}>
                    <StatusDot state={server.state} />
                    {server.state}
                  </span>
                </div>
                <ChevronRight className="chevron" size={19} />
              </div>
              <div className="server-meta">
                <span>
                  <Cpu size={15} /> {server.config.type}
                </span>
                <span>
                  <HardDrive size={15} /> {server.config.maxMemory}
                </span>
                <span>
                  <Users size={15} /> {server.config.maxPlayers}
                </span>
              </div>
              <div className="server-address">
                <code>:{server.config.port}</code>
                <span>Minecraft {server.config.version}</span>
              </div>
              {server.restartRequired && (
                <div className="pending-badge">Changes waiting to apply</div>
              )}
              {(server.runtimeError || server.state === "unhealthy") && (
                <div
                  className="server-error-badge"
                  title={
                    server.runtimeError?.message || "Container is unhealthy"
                  }
                >
                  <TriangleAlert size={13} />
                  {server.runtimeError?.exitCode != null
                    ? `Error · exit ${server.runtimeError.exitCode}`
                    : "Needs attention"}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}
    </Layout>
  );
}
