import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import type { ServerConfig, ServerSummary } from "@mineserver/shared";
import { api, jsonBody } from "../api";
import { Layout } from "../components/Layout";
import { ServerForm, defaultServerConfig } from "../components/ServerForm";

export function CreateServerPage() {
  const navigate = useNavigate();
  const [versions, setVersions] = useState<string[]>([]);
  useEffect(() => {
    api<{ versions: Array<{ id: string; type: string }> }>("/api/metadata")
      .then((metadata) =>
        setVersions(
          metadata.versions
            .filter((version) => version.type === "release")
            .map((version) => version.id),
        ),
      )
      .catch(() => undefined);
  }, []);
  async function create(value: ServerConfig, acceptEula: boolean) {
    const server = await api<ServerSummary>("/api/servers", {
      method: "POST",
      ...jsonBody({ ...value, acceptEula }),
    });
    navigate(`/servers/${server.id}`);
  }
  return (
    <Layout
      title="Create a server"
      subtitle="A dedicated Compose project, world directory, and backup schedule."
      actions={
        <Link className="button ghost" to="/">
          <ArrowLeft size={17} /> Back
        </Link>
      }
    >
      <ServerForm
        initial={defaultServerConfig}
        submitLabel="Create server"
        requireEula
        versionSuggestions={versions}
        onSubmit={create}
      />
    </Layout>
  );
}
