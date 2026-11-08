import { createReadStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { rm, stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { AddonToggleSchema, addonKind } from "@mineserver/shared";
import {
  addonFilePath,
  createAddonsArchive,
  createTempUpload,
  installAddonBatch,
  listAddons,
  removeAddon,
  setAddonEnabled,
} from "../addons.js";
import { instancePaths } from "../compose.js";
import { config } from "../config.js";
import type { AppContext } from "../app.js";
import { enforceTotalLimit, requireServer, rowConfig } from "../helpers.js";
import { safeFilename } from "../utils.js";

export async function addonsRoutes(
  app: FastifyInstance,
  context: AppContext,
): Promise<void> {
  const { store, jobs } = context;

  app.get<{ Params: { id: string } }>(
    "/api/servers/:id/addons",
    async (request) => {
      const row = requireServer(store, request.params.id);
      const kind = addonKind(rowConfig(row).type);
      if (!kind) return { kind: null, files: [] };
      return {
        kind,
        files: await listAddons(
          instancePaths(config.instancesRoot, row.id).addons,
        ),
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/servers/:id/addons",
    async (request, reply) => {
      const row = requireServer(store, request.params.id);
      const kind = addonKind(rowConfig(row).type);
      if (!kind)
        throw new Error("This server type does not support managed add-ons");
      const uploads: Array<{ path: string; originalName: string }> = [];
      const limit = enforceTotalLimit();
      try {
        for await (const file of request.files()) {
          const temp = await createTempUpload(config.tempRoot);
          uploads.push({ path: temp.path, originalName: file.filename });
          await pipeline(file.file, limit(), temp.stream);
          if (file.file.truncated)
            throw new Error("Upload exceeds the configured size limit");
        }
        if (uploads.length === 0)
          throw new Error("Choose one or more JAR or ZIP files");
        const invalid = uploads.find(
          (upload) =>
            ![".jar", ".zip"].includes(
              path.extname(upload.originalName).toLowerCase(),
            ),
        );
        if (invalid)
          throw new Error(
            `Only JAR and ZIP uploads are accepted: ${invalid.originalName}`,
          );
        const directory = instancePaths(config.instancesRoot, row.id).addons;
        const installed = await jobs.mutations.runExclusive(
          row.id,
          "addon-upload",
          async () => {
            const result = await installAddonBatch(uploads, directory);
            store.touchServerRevision(row.id);
            return result;
          },
        );
        return reply.code(201).send({ installed, restartRequired: true });
      } finally {
        await Promise.all(
          uploads.map((upload) => rm(upload.path, { force: true })),
        );
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/servers/:id/addons/download-all",
    async (request, reply) => {
      const row = requireServer(store, request.params.id);
      const kind = addonKind(rowConfig(row).type);
      if (!kind)
        throw new Error("This server type does not support managed add-ons");
      const directory = instancePaths(config.instancesRoot, row.id).addons;
      const archive = await createAddonsArchive(directory);
      reply.header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(`${row.slug}-${kind}.zip`)}`,
      );
      reply.type("application/zip");
      return reply.send(archive);
    },
  );

  app.get<{ Params: { id: string; filename: string } }>(
    "/api/servers/:id/addons/:filename/download",
    async (request, reply) => {
      const row = requireServer(store, request.params.id);
      const filename = safeFilename(
        decodeURIComponent(request.params.filename),
      );
      const target = await addonFilePath(
        instancePaths(config.instancesRoot, row.id).addons,
        filename,
      );
      const info = await stat(target);
      reply.header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      reply.header("content-length", String(info.size));
      reply.type("application/java-archive");
      return reply.send(createReadStream(target));
    },
  );

  app.patch<{
    Params: { id: string; filename: string };
  }>("/api/servers/:id/addons/:filename", async (request) => {
    const row = requireServer(store, request.params.id);
    const { enabled } = AddonToggleSchema.parse(request.body);
    return jobs.mutations.runExclusive(row.id, "addon-toggle", async () => {
      await setAddonEnabled(
        instancePaths(config.instancesRoot, row.id).addons,
        decodeURIComponent(request.params.filename),
        enabled,
      );
      store.touchServerRevision(row.id);
      return { ok: true, restartRequired: true };
    });
  });

  app.delete<{
    Params: { id: string; filename: string };
  }>("/api/servers/:id/addons/:filename", async (request) => {
    const row = requireServer(store, request.params.id);
    const filename = decodeURIComponent(request.params.filename);
    return jobs.mutations.runExclusive(row.id, "addon-delete", async () => {
      await removeAddon(
        instancePaths(config.instancesRoot, row.id).addons,
        filename,
      );
      store.deleteAddonSource(row.id, filename);
      store.touchServerRevision(row.id);
      return { ok: true, restartRequired: true };
    });
  });
}
