import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  Blocks,
  Boxes,
  DatabaseBackup,
  FolderTree,
  LayoutDashboard,
  RefreshCw,
  ScrollText,
  Settings,
  SquareTerminal,
  TriangleAlert,
} from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { ServerSummary } from "@mineserver/shared";
import { api } from "../api";
import { ErrorBanner, Layout, StatusDot } from "../components/Layout";
import { OverviewTab } from "./server/OverviewTab";
import { ConsoleTab } from "./server/ConsoleTab";
import { AddonsTab } from "./server/AddonsTab";
import { BackupsTab } from "./server/BackupsTab";
import { SettingsTab } from "./server/SettingsTab";
import { FilesTab } from "./server/FilesTab";
import { DockerLogsTab } from "./server/DockerLogsTab";

const tabs = [
  ["overview", "Overview", LayoutDashboard],
  ["console", "Console", SquareTerminal],
  ["docker-logs", "Docker logs", ScrollText],
  ["addons", "Add-ons", Boxes],
  ["files", "Files", FolderTree],
  ["backups", "Backups", DatabaseBackup],
  ["settings", "Settings", Settings],
] as const;

export function ServerPage() {
  const { id = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const tab = search.get("tab") ?? "overview";
  const [server, setServer] = useState<ServerSummary | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setServer(await api<ServerSummary>(`/api/servers/${id}`));
      setError("");
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to load server",
      );
    }
  }, [id]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [load]);

  if (!server) {
    return (
      <Layout title="Loading server…">
        {error && <ErrorBanner message={error} />}
      </Layout>
    );
  }
  return (
    <Layout
      title={server.config.name}
      subtitle={`${server.config.type} · Minecraft ${server.config.version} · Port ${server.config.port}`}
      actions={
        <>
          <span className={`header-status status-${server.state}`}>
            <StatusDot state={server.state} />{" "}
            {server.state === "stopped" && server.wakeProxyRunning
              ? "sleeping"
              : server.state}
          </span>
          <button className="button ghost" onClick={() => void load()}>
            <RefreshCw size={17} /> Refresh
          </button>
          <Link className="button ghost" to="/">
            <ArrowLeft size={17} /> All servers
          </Link>
        </>
      }
    >
      {error && <ErrorBanner message={error} />}
      {server.runtimeError && (
        <div className="runtime-error-banner" role="alert">
          <TriangleAlert size={20} />
          <span>
            <strong>Container stopped after an error.</strong>{" "}
            {server.runtimeError.message}
            {server.runtimeError.occurredAt && (
              <small>
                {new Date(server.runtimeError.occurredAt).toLocaleString()}
              </small>
            )}
          </span>
          <button
            className="button ghost"
            onClick={() => setSearch({ tab: "docker-logs" })}
          >
            View logs
          </button>
        </div>
      )}
      {server.restartRequired && (
        <div className="notice-banner">
          <Blocks size={19} />
          <span>
            <strong>Changes are waiting.</strong> Apply them when you are ready
            to recreate the server.
          </span>
        </div>
      )}
      <nav className="tabs">
        {tabs.map(([key, label, Icon]) => (
          <button
            key={key}
            className={tab === key ? "active" : ""}
            onClick={() => setSearch(key === "overview" ? {} : { tab: key })}
          >
            <Icon size={17} /> {label}
          </button>
        ))}
      </nav>
      {tab === "overview" && <OverviewTab server={server} refresh={load} />}
      {tab === "console" && <ConsoleTab server={server} />}
      {tab === "docker-logs" && <DockerLogsTab server={server} />}
      {tab === "addons" && <AddonsTab server={server} />}
      {tab === "files" && <FilesTab server={server} />}
      {tab === "backups" && <BackupsTab server={server} refreshServer={load} />}
      {tab === "settings" && <SettingsTab server={server} refresh={load} />}
    </Layout>
  );
}
