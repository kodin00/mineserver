import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { useAuth } from "../../auth";
import { ErrorBanner } from "../../components/Layout";

type Request = {
  id: string;
  items: Array<{
    projectId: string;
    versionId: string;
    projectType: string;
    title?: string;
    versionNumber?: string;
  }>;
  status: string;
  error?: string | null;
  createdAt: string;
};

export function RequestsTab({ serverId }: { serverId: string }) {
  const { role } = useAuth();
  const [requests, setRequests] = useState<Request[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    try {
      const response = await api<{ requests: Request[] }>(
        `/api/servers/${serverId}/mod-requests`,
      );
      setRequests(response.requests);
      setError("");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to load requests",
      );
    }
  }, [serverId]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  async function decide(id: string, action: "approve" | "decline") {
    setBusy(id);
    setError("");
    try {
      await api(`/api/servers/${serverId}/mod-requests/${id}/${action}`, {
        method: "POST",
      });
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to update request",
      );
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="tab-stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Mod requests</h2>
            <p>
              {role === "admin"
                ? "Approving starts installation immediately. Restart the server separately when you are ready."
                : "Track the projects you have sent to an administrator."}
            </p>
          </div>
        </div>
        {error && <ErrorBanner message={error} />}
        {requests.length === 0 && (
          <p className="muted">
            No requests yet.{" "}
            {role === "player" && "Choose projects in Mods to make a request."}
          </p>
        )}
        {requests.map((request) => (
          <article className="request-card" key={request.id}>
            <div className="request-card-heading">
              <strong>{request.status}</strong>
              <time className="muted">
                {new Date(request.createdAt).toLocaleString()}
              </time>
            </div>
            <ul>
              {request.items.map((item) => (
                <li key={`${item.projectId}-${item.versionId}`}>
                  <a
                    href={`https://modrinth.com/${item.projectType}/${encodeURIComponent(item.projectId)}`}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {item.title || item.projectId}
                  </a>{" "}
                  <small className="muted">
                    · {item.projectType} · version{" "}
                    {item.versionNumber || item.versionId}
                  </small>
                </li>
              ))}
            </ul>
            {request.error && <p role="alert">{request.error}</p>}
            {role === "admin" && request.status === "pending" && (
              <div className="button-row">
                <button
                  className="button primary"
                  disabled={!!busy}
                  onClick={() => void decide(request.id, "approve")}
                >
                  Approve and install
                </button>
                <button
                  className="button ghost"
                  disabled={!!busy}
                  onClick={() => void decide(request.id, "decline")}
                >
                  Decline
                </button>
              </div>
            )}
          </article>
        ))}
      </section>
    </div>
  );
}
