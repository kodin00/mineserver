import { useEffect, useRef, useState, type FormEvent } from "react";
import { CornerDownLeft, TerminalSquare, Trash2 } from "lucide-react";
import type { ServerSummary } from "@mineserver/shared";
import { api, jsonBody, websocketUrl } from "../../api";
import { ErrorBanner } from "../../components/Layout";

export function ConsoleTab({ server }: { server: ServerSummary }) {
  const [lines, setLines] = useState<string[]>([]);
  const [command, setCommand] = useState("");
  const [error, setError] = useState("");
  const terminal = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (server.state !== "running") return;
    const socket = new WebSocket(websocketUrl(`/ws/servers/${server.id}/logs`));
    socket.onmessage = (event) => {
      setLines((current) =>
        [...current, ...String(event.data).split("\n")].slice(-1000),
      );
    };
    socket.onerror = () => setError("Live log connection was interrupted");
    return () => socket.close();
  }, [server.id, server.state]);

  useEffect(() => {
    terminal.current?.scrollTo({ top: terminal.current.scrollHeight });
  }, [lines]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!command.trim()) return;
    const sent = command.trim();
    setCommand("");
    setLines((current) => [...current, `> ${sent}`]);
    try {
      const response = await api<{ output: string }>(
        `/api/servers/${server.id}/console`,
        {
          method: "POST",
          ...jsonBody({ command: sent }),
        },
      );
      if (response.output) setLines((current) => [...current, response.output]);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Command failed");
    }
  }

  return (
    <div className="tab-stack">
      {error && <ErrorBanner message={error} />}
      <div className="console-panel">
        <div className="console-toolbar">
          <span>
            <TerminalSquare size={17} /> Live console
          </span>
          <button
            className="icon-button dark"
            title="Clear"
            onClick={() => setLines([])}
          >
            <Trash2 size={16} />
          </button>
        </div>
        <div className="terminal" ref={terminal}>
          {server.state !== "running" ? (
            <div className="terminal-empty">
              Start the server to open its live console.
            </div>
          ) : lines.length === 0 ? (
            <div className="terminal-empty">Connecting to container logs…</div>
          ) : (
            lines.map((line, index) => (
              <div key={`${index}-${line.slice(0, 12)}`}>
                {line || "\u00a0"}
              </div>
            ))
          )}
        </div>
        <form className="command-row" onSubmit={submit}>
          <span>&gt;</span>
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder={
              server.state === "running"
                ? "Type a Minecraft command…"
                : "Server is stopped"
            }
            disabled={server.state !== "running"}
          />
          <button
            className="icon-button dark"
            disabled={!command.trim() || server.state !== "running"}
          >
            <CornerDownLeft size={17} />
          </button>
        </form>
      </div>
    </div>
  );
}
