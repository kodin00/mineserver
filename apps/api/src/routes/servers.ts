import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  ConsoleCommandSchema,
  CreateServerSchema,
  PlayerActionSchema,
  ServerConfigSchema,
  WhitelistActionSchema,
  addonKind,
} from "@mineserver/shared";
import { ensureAddonsReadable, listAddons } from "../addons.js";
import { createBackup } from "../backups.js";
import { instancePaths, writeCompose } from "../compose.js";
import { config } from "../config.js";
import type { AppContext } from "../app.js";
import {
  requireServer,
  rowConfig,
  serverSummary,
  uniqueSlug,
} from "../helpers.js";
import {
  listOnlinePlayers,
  runPlayerAction,
  runWhitelistAction,
} from "../players.js";
import { pathExists, randomToken, sha256 } from "../utils.js";

export async function serversRoutes(
  app: FastifyInstance,
  context: AppContext,
): Promise<void> {
  const { store, docker, jobs } = context;

  app.get("/api/servers", async () =>
    Promise.all(store.listServers().map((row) => serverSummary(row, docker))),
  );

  app.post("/api/servers", async (request, reply) => {
    const parsed = CreateServerSchema.parse(request.body);
    const { acceptEula: _acceptEula, ...input } = parsed;
    const serverConfig = ServerConfigSchema.parse(input);
    if (store.getServerByPort(serverConfig.port)) {
      throw Object.assign(
        new Error(`Port ${serverConfig.port} is already assigned`),
        {
          statusCode: 409,
        },
      );
    }
    const id = crypto.randomUUID();
    const slug = uniqueSlug(store, serverConfig.name);
    const paths = instancePaths(config.instancesRoot, id);
    store.insertServer(id, slug, serverConfig);
    try {
      await writeCompose(id, serverConfig, paths);
    } catch (error) {
      store.deleteServer(id);
      await rm(paths.root, { recursive: true, force: true });
      throw error;
    }
    return reply
      .code(201)
      .send(await serverSummary(store.getServer(id)!, docker));
  });

  app.get<{ Params: { id: string } }>("/api/servers/:id", async (request) => {
    const row = requireServer(store, request.params.id);
    return serverSummary(row, docker);
  });

  app.put<{ Params: { id: string } }>("/api/servers/:id", async (request) => {
    const row = requireServer(store, request.params.id);
    const serverConfig = ServerConfigSchema.parse(request.body);
    if (store.getServerByPort(serverConfig.port, row.id)) {
      throw Object.assign(
        new Error(`Port ${serverConfig.port} is already assigned`),
        {
          statusCode: 409,
        },
      );
    }
    return jobs.mutations.runExclusive(
      row.id,
      "server-config-update",
      async () => {
        store.updateServer(row.id, serverConfig);
        await writeCompose(
          row.id,
          serverConfig,
          instancePaths(config.instancesRoot, row.id),
        );
        return serverSummary(store.getServer(row.id)!, docker);
      },
    );
  });

  app.post<{
    Params: { id: string; action: string };
  }>("/api/servers/:id/actions/:action", async (request, reply) => {
    const row = requireServer(store, request.params.id);
    const paths = instancePaths(config.instancesRoot, row.id);
    const action = request.params.action;
    const operation = jobs.runExclusive(row.id, action, async () => {
      if (
        ["run", "start", "rebuild", "apply", "restart", "pull"].includes(action)
      ) {
        await ensureAddonsReadable(paths.addons);
      }
      if (action === "run" || action === "start") {
        const runtime = await docker.status(row.id, paths);
        await docker.startExisting(row.id, paths);
        // With no existing container, Compose creates one from the current
        // file. Otherwise --no-recreate deliberately leaves changes pending.
        if (!runtime.exists) {
          store.markApplied(row.id);
          await rm(paths.backupMigrationMarker, { force: true });
        }
      } else if (action === "rebuild" || action === "apply") {
        await docker.rebuild(row.id, paths);
        store.markApplied(row.id);
        await rm(paths.backupMigrationMarker, { force: true });
      } else if (action === "stop") {
        await docker.stop(row.id, paths);
      } else if (action === "restart") {
        await docker.restart(row.id, paths);
      } else if (action === "pull") {
        await docker.pull(row.id, paths);
        store.markApplied(row.id);
        await rm(paths.backupMigrationMarker, { force: true });
      } else if (action === "backup") {
        await createBackup(row.id, paths, docker, rowConfig(row).backups);
      } else {
        throw new Error("Unknown action");
      }
    });
    return reply.code(202).send(operation);
  });

  app.get<{ Params: { id: string } }>(
    "/api/servers/:id/stats",
    async (request) => {
      const row = requireServer(store, request.params.id);
      return docker.stats(row.id, instancePaths(config.instancesRoot, row.id));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/servers/:id/players",
    async (request) => {
      const row = requireServer(store, request.params.id);
      return listOnlinePlayers(
        docker,
        row.id,
        instancePaths(config.instancesRoot, row.id),
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/servers/:id/players/actions",
    async (request) => {
      const row = requireServer(store, request.params.id);
      const body = PlayerActionSchema.parse(request.body);
      return jobs.mutations.runExclusive(row.id, "player-action", () =>
        runPlayerAction(
          docker,
          row.id,
          instancePaths(config.instancesRoot, row.id),
          body,
        ),
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/servers/:id/whitelist/actions",
    async (request) => {
      const row = requireServer(store, request.params.id);
      const body = WhitelistActionSchema.parse(request.body);
      return jobs.mutations.runExclusive(row.id, "whitelist-action", () =>
        runWhitelistAction(
          docker,
          row.id,
          instancePaths(config.instancesRoot, row.id),
          body,
        ),
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/servers/:id/addons/share",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const row = requireServer(store, request.params.id);
      const kind = addonKind(rowConfig(row).type);
      if (!kind)
        throw new Error("This server type does not support managed add-ons");
      const files = await listAddons(
        instancePaths(config.instancesRoot, row.id).addons,
      );
      if (files.length === 0) throw new Error("No add-ons to share");
      const token = randomToken();
      const expiresAt = new Date(
        Date.now() + config.ADDON_SHARE_TTL_MINUTES * 60_000,
      ).toISOString();
      store.createAddonShare(sha256(token), row.id, expiresAt);
      return reply.code(201).send({
        path: `/api/public/addons/${token}`,
        expiresAt,
      });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { tail?: string } }>(
    "/api/servers/:id/logs",
    async (request) => {
      const row = requireServer(store, request.params.id);
      const requestedTail = Number.parseInt(request.query.tail ?? "1000", 10);
      const tail = Number.isFinite(requestedTail)
        ? Math.min(Math.max(requestedTail, 50), 5000)
        : 1000;
      return {
        logs: (
          await docker.logs(
            row.id,
            instancePaths(config.instancesRoot, row.id),
            tail,
          )
        ).stdout,
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/servers/:id/console",
    async (request) => {
      const row = requireServer(store, request.params.id);
      const body = ConsoleCommandSchema.parse(request.body);
      return jobs.mutations.runExclusive(
        row.id,
        "console-command",
        async () => {
          const result = await docker.console(
            row.id,
            instancePaths(config.instancesRoot, row.id),
            body.command,
          );
          return { output: result.stdout.trim() };
        },
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/servers/:id/operations",
    async (request) => {
      requireServer(store, request.params.id);
      return store.listOperations(request.params.id);
    },
  );

  app.delete<{
    Params: { id: string };
    Querystring: { permanent?: string };
  }>("/api/servers/:id", async (request) => {
    const row = requireServer(store, request.params.id);
    return jobs.mutations.runExclusive(row.id, "server-delete", async () => {
      const paths = instancePaths(config.instancesRoot, row.id);
      await docker.down(row.id, paths).catch(() => undefined);
      if (request.query.permanent === "true") {
        await rm(paths.root, { recursive: true, force: true });
      } else if (await pathExists(paths.root)) {
        const archiveRoot = path.join(config.DATA_ROOT, "archived");
        await mkdir(archiveRoot, { recursive: true });
        await rename(
          paths.root,
          path.join(archiveRoot, `${row.slug}-${Date.now()}`),
        );
      }
      store.deleteServer(row.id);
      return { ok: true };
    });
  });
}
