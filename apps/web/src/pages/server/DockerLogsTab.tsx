import { useCallback, useEffect, useRef, useState } from "react";
import { Container, LoaderCircle, RefreshCw } from "lucide-react";
import type { ServerSummary } from "@mineserver/shared";
import { api } from "../../api";
import { ErrorBanner } from "../../components/Layout";

const logTail = 1000;

export function DockerLogsTab({ server }: { server: ServerSummary }) {
  const [logs, setLogs] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const terminal = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  const load = useCallback(
    async (signal?: AbortSignal, silent = false) => {
      if (!silent) setLoading(true);
      try {
        const response = await api<{ logs: string }>(
          `/api/servers/${server.id}/logs?tail=${logTail}`,
          signal ? { signal } : {},
        );
        setLogs(response.logs);
        setUpdatedAt(new Date());
        setError("");
      } catch (error) {
        if (signal?.aborted) return;
        setError(
          error instanceof Error ? error.message : "Unable to load Docker logs",
        );
      } finally {
        if (!signal?.aborted && !silent) setLoading(false);
      }
    },
    [server.id],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const active =
      server.containerExists &&
      ["running", "starting", "unhealthy"].includes(server.state);
    const timer = active
      ? window.setInterval(() => void load(controller.signal, true), 5000)
      : null;
    return () => {
      controller.abort();
      if (timer !== null) window.clearInterval(timer);
    };
  }, [load, server.containerExists, server.state]);

  useEffect(() => {
    if (pinnedToBottom.current) {
      terminal.current?.scrollTo({ top: terminal.current.scrollHeight });
    }
  }, [logs]);

  return (
    <div className="tab-stack">
      {error && <ErrorBanner message={error} />}
      <div className="console-panel docker-logs-panel">
        <div className="console-toolbar docker-logs-toolbar">
          <div>
            <span>
              <Container size={17} /> Docker logs
            </span>
            <small>
              Last {logTail.toLocaleString()} lines · retained while this
              container exists
            </small>
          </div>
          <div className="docker-log-actions">
            {updatedAt && (
              <small>Updated {updatedAt.toLocaleTimeString()}</small>
            )}
            <button
              className="button ghost"
              disabled={loading}
              onClick={() => void load()}
            >
              {loading ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <RefreshCw size={16} />
              )}
              Refresh
            </button>
          </div>
        </div>
        <div
          className="terminal docker-log-terminal"
          ref={terminal}
          onScroll={(event) => {
            const element = event.currentTarget;
            pinnedToBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              40;
          }}
          aria-live="polite"
        >
          {loading && logs === null ? (
            <div className="terminal-empty">Loading retained Docker logs…</div>
          ) : logs ? (
            logs
          ) : (
            <div className="terminal-empty">
              No Docker logs are available for this container yet.
            </div>
          )}
        </div>
        <div className="docker-log-footnote">
          Logs remain available after the container stops. Rebuilding or
          deleting the container removes its Docker log history.
        </div>
      </div>
    </div>
  );
}
