import type { FastifyInstance } from "fastify";
import { instancePaths } from "../compose.js";
import { config } from "../config.js";
import type { AppContext } from "../app.js";

interface VersionManifest {
  versions?: unknown[];
}

const MAX_SNAPSHOTS = 50;

// Keep every release plus the newest snapshots, in manifest order (newest
// first). A plain slice of the manifest is mostly snapshots and drops the
// older releases that modded servers still need, such as 1.20.1.
export function selectVersions(versions: unknown[]): unknown[] {
  let snapshots = 0;
  return versions.filter((version) => {
    const type = (version as { type?: unknown } | null)?.type;
    if (type === "release") return true;
    return type === "snapshot" && snapshots++ < MAX_SNAPSHOTS;
  });
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
        ? selectVersions(versions.value.versions ?? [])
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
      const value = await fetchMetadata();
      // A failed upstream fetch yields empty data; keep it only briefly so one
      // transient outage does not blank the version list for an hour.
      const complete = value.versions.length > 0 && value.imageTags !== null;
      metadataCache = {
        value,
        expires: Date.now() + (complete ? 60 * 60_000 : 30_000),
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
