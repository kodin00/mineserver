import { createReadStream } from "node:fs";
import path from "node:path";
import { stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import {
  createBackup,
  listBackups,
  removeBackup,
  restoreBackup,
} from "../backups.js";
import { instancePaths } from "../compose.js";
import { config } from "../config.js";
import type { AppContext } from "../app.js";
import { requireServer } from "../helpers.js";
import { pathExists, safeFilename } from "../utils.js";

export async function backupsRoutes(
  app: FastifyInstance,
  context: AppContext,
): Promise<void> {
  const { store, docker, jobs } = context;

  app.get<{ Params: { id: string } }>(
    "/api/servers/:id/backups",
    async (request) => {
      const row = requireServer(store, request.params.id);
      return listBackups(instancePaths(config.instancesRoot, row.id).backups);
    },
  );

  app.get<{ Params: { id: string; filename: string } }>(
    "/api/servers/:id/backups/:filename/download",
    async (request, reply) => {
      const row = requireServer(store, request.params.id);
      const filename = safeFilename(
        decodeURIComponent(request.params.filename),
      );
      const target = path.join(
        instancePaths(config.instancesRoot, row.id).backups,
        filename,
      );
      if (!(await pathExists(target)))
        throw Object.assign(new Error("Backup not found"), { statusCode: 404 });
      const info = await stat(target);
      reply.header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      reply.header("content-length", String(info.size));
      reply.type(
        filename.toLowerCase().endsWith(".zip")
          ? "application/zip"
          : "application/gzip",
      );
      return reply.send(createReadStream(target));
    },
  );

  app.post<{ Params: { id: string; filename: string } }>(
    "/api/servers/:id/backups/:filename/restore",
    async (request, reply) => {
      const row = requireServer(store, request.params.id);
      const filename = decodeURIComponent(request.params.filename);
      const paths = instancePaths(config.instancesRoot, row.id);
      const operation = jobs.runExclusive(row.id, "restore", () =>
        restoreBackup(row.id, filename, paths, docker),
      );
      return reply.code(202).send(operation);
    },
  );

  app.delete<{ Params: { id: string; filename: string } }>(
    "/api/servers/:id/backups/:filename",
    async (request) => {
      const row = requireServer(store, request.params.id);
      return jobs.mutations.runExclusive(row.id, "backup-delete", async () => {
        await removeBackup(
          instancePaths(config.instancesRoot, row.id).backups,
          decodeURIComponent(request.params.filename),
        );
        return { ok: true };
      });
    },
  );
}
