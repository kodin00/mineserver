import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Blocks,
  Boxes,
  DatabaseBackup,
  FolderTree,
  Globe2,
  LayoutDashboard,
  RefreshCw,
  ClipboardList,
  Copy,
  ScrollText,
  Settings,
  SquareTerminal,
  TriangleAlert,
  Users,
} from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { ServerSummary } from "@mineserver/shared";
import { useAuth } from "../auth";
import { api } from "../api";
import { ErrorBanner, Layout, StatusDot } from "../components/Layout";
import { OverviewTab } from "./server/OverviewTab";
import { ConsoleTab } from "./server/ConsoleTab";
import { ModsTab } from "./server/ModsTab";
import { BackupsTab } from "./server/BackupsTab";
import { SettingsTab } from "./server/SettingsTab";
import { FilesTab } from "./server/FilesTab";
import { DockerLogsTab } from "./server/DockerLogsTab";
import { WorldsTab } from "./server/WorldsTab";
import { RequestsTab } from "./server/RequestsTab";
import { PlayersTab } from "./server/PlayersTab";

const tabs = [
  ["overview", "Overview", LayoutDashboard],
  ["players", "Players", Users],
  ["console", "Console", SquareTerminal],
  ["docker-logs", "Docker logs", ScrollText],
  ["mods", "Mods", Boxes],
  ["requests", "Requests", ClipboardList],
  ["files", "Files", FolderTree],
  ["world", "World", Globe2],
  ["backups", "Backups", DatabaseBackup],
  ["settings", "Settings", Settings],
] as const;

export function ServerPage() {
  const { role } = useAuth();
  const demo = import.meta.env.VITE_DEMO === "true";
  const [copyMessage, setCopyMessage] = useState("");
  const copyTimer = useRef<number | undefined>(undefined);
  const [pending, setPending] = useState(0);
  const { id = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const requestedTab = search.get("tab") ?? "overview";
  const tab = ["addons", "browse"].includes(requestedTab)
    ? "mods"
    : requestedTab;
  const [server, setServer] = useState<ServerSummary | null>(null);
  const [marketplaceEnabled, setMarketplaceEnabled] = useState(true);
  const [error, setError] = useState("");
  function showCopyMessage(message: string) {
    setCopyMessage(message);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyMessage(""), 4000);
  }
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  // Switching servers must not keep showing the previous server's summary.
  useEffect(() => {
    setServer(null);
    setError("");
  }, [id]);
  useEffect(() => {
    let cancelled = false;
    void api<{ modrinthEnabled?: boolean }>("/api/metadata")
      .then((metadata) => {
        if (!cancelled)
          setMarketplaceEnabled(metadata.modrinthEnabled !== false);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const currentId = useRef(id);
  currentId.current = id;
  const load = useCallback(async () => {
    // Fast server switching re-renders this component with a new id; drop
    // responses that arrive after the switch so we never render or control
    // the wrong server.
    try {
      const summary = await api<ServerSummary>(`/api/servers/${id}`);
      if (currentId.current !== id) return;
      setServer(summary);
      setError("");
    } catch (error) {
      if (currentId.current !== id) return;
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

  useEffect(() => {
    const loadRequests = () =>
      void api<{ requests: Array<{ status: string }> }>(
        `/api/servers/${id}/mod-requests`,
      )
        .then((result) =>
          setPending(
            result.requests.filter((item) => item.status === "pending").length,
          ),
        )
        .catch(() => undefined);
    loadRequests();
    const timer = setInterval(loadRequests, 5000);
    return () => clearInterval(timer);
  }, [id]);

  if (!server) {
    return (
      <Layout title="Loading server…">
        {error && <ErrorBanner message={error} />}
      </Layout>
    );
  }
  const visibleTabs = tabs.filter(
    ([key]) =>
      (role === "admin" || ["overview", "mods", "requests"].includes(key)) &&
      (role === "admin" || marketplaceEnabled || key !== "mods") &&
      (!demo || key !== "console"),
  );
  const activeTab = visibleTabs.some(([key]) => key === tab) ? tab : "overview";

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
      {role === "admin" && server.runtimeError && (
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
      {role === "admin" && server.restartRequired && (
        <div className="notice-banner">
          <Blocks size={19} />
          <span>
            <strong>Changes are waiting.</strong> Apply them when you are ready
            to recreate the server.
          </span>
        </div>
      )}
      <nav className="tabs">
        {visibleTabs.map(([key, label, Icon]) => (
          <button
            key={key}
            className={activeTab === key ? "active" : ""}
            aria-current={activeTab === key ? "page" : undefined}
            onClick={() => setSearch(key === "overview" ? {} : { tab: key })}
          >
            <Icon size={17} /> {label}
            {key === "requests" && role === "admin" && pending > 0
              ? ` (${pending})`
              : ""}
          </button>
        ))}
      </nav>
      {activeTab === "overview" && (
        <section className="panel address-panel">
          <div>
            <h2>Join address</h2>
            <p>
              {server.config.publicAddress ? (
                <code>{server.config.publicAddress}</code>
              ) : (
                "An administrator has not set a public address yet."
              )}
            </p>
          </div>
          {server.config.publicAddress && (
            <button
              className="button ghost"
              onClick={() => {
                if (!navigator.clipboard) {
                  showCopyMessage("Select and copy the address above.");
                  return;
                }
                void navigator.clipboard
                  .writeText(server.config.publicAddress)
                  .then(() => showCopyMessage("Address copied."))
                  .catch(() =>
                    showCopyMessage("Select and copy the address above."),
                  );
              }}
            >
              <Copy size={16} /> Copy address
            </button>
          )}
          {copyMessage && <span role="status">{copyMessage}</span>}
        </section>
      )}
      {activeTab === "overview" && role === "admin" && (
        <OverviewTab server={server} refresh={load} />
      )}
      {activeTab === "requests" && <RequestsTab serverId={id} />}
      {activeTab === "players" && <PlayersTab server={server} />}
      {activeTab === "console" && <ConsoleTab server={server} />}
      {activeTab === "docker-logs" && <DockerLogsTab server={server} />}
      {activeTab === "mods" && (
        <ModsTab
          key={server.id}
          server={server}
          marketplaceEnabled={marketplaceEnabled}
          refresh={load}
        />
      )}
      {activeTab === "files" && <FilesTab server={server} />}
      {activeTab === "world" && (
        <WorldsTab server={server} refreshServer={load} />
      )}
      {activeTab === "backups" && (
        <BackupsTab server={server} refreshServer={load} />
      )}
      {activeTab === "settings" && (
        <SettingsTab server={server} refresh={load} />
      )}
    </Layout>
  );
}
