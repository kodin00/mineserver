import type { FastifyInstance } from "fastify";
import { instancePaths } from "../compose.js";
import { config } from "../config.js";
import type { AppContext } from "../app.js";

interface VersionManifest {
  versions?: unknown[];
}

async function fetchMetadata() {
  // Bounded: a hung upstream must not hold the request open indefinitely.
  const signal = AbortSignal.timeout(10_000);
  const [versions, images] = await Promise.allSettled([
    fetch("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json", {
      signal,
    }).then((res) => {
      if (!res.ok) throw new Error("Version service unavailable");
      return res.json() as Promise<VersionManifest>;
    }),
    fetch(
      "https://raw.githubusercontent.com/itzg/docker-minecraft-server/refs/heads/master/images.json",
      { signal },
    ).then((res) => {
      if (!res.ok) throw new Error("Image metadata unavailable");
      return res.json();
    }),
  ]);
  return {
    versions:
      versions.status === "fulfilled"
        ? (versions.value.versions?.slice(0, 100) ?? [])
        : [],
    imageTags: images.status === "fulfilled" ? images.value : null,
  };
}

interface Metadata {
  versions: unknown[];
  imageTags: unknown;
}

export async function consoleRoutes(
  app: FastifyInstance,
  context: AppContext,
): Promise<void> {
  const { store, docker, jobs } = context;

  let metadataCache: { value: Metadata; expires: number } | null = null;
  app.get("/api/metadata", async () => {
    if (!metadataCache || metadataCache.expires < Date.now()) {
      metadataCache = {
        value: await fetchMetadata(),
        expires: Date.now() + 60 * 60_000,
      };
    }
    // Read outside the cached payload so toggling the flag takes effect at once.
    const settingsRow = store.getPanelSettings(config.MODRINTH_ENABLED);
    return {
      ...metadataCache.value,
      modrinthEnabled: settingsRow.modrinth_enabled === 1,
    };
  });

  app.get("/ws/operations", { websocket: true }, (socket) => {
    const handler = (operation: unknown) => {
      if (socket.readyState === socket.OPEN)
        socket.send(JSON.stringify(operation));
    };
    jobs.on("operation", handler);
    socket.on("close", () => jobs.off("operation", handler));
  });

  app.get<{ Params: { id: string } }>(
    "/ws/servers/:id/logs",
    { websocket: true },
    (socket, request) => {
      const row = store.getServer(request.params.id);
      if (!row) {
        socket.close(1008, "Server not found");
        return;
      }
      const child = docker.followLogs(
        row.id,
        instancePaths(config.instancesRoot, row.id),
      );
      child.on("error", () => {
        if (socket.readyState === socket.OPEN)
          socket.close(1011, "log stream failed");
      });
      const send = (chunk: Buffer) => {
        if (socket.readyState === socket.OPEN) socket.send(chunk.toString());
      };
      child.stdout.on("data", send);
      child.stderr.on("data", send);
      child.on("close", (code) => {
        if (socket.readyState === socket.OPEN)
          socket.close(1000, `logs exited ${code ?? 0}`);
      });
      socket.on("close", () => child.kill("SIGTERM"));
    },
  );
}
