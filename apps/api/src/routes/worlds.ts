import { createReadStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { WorldImportSchema } from "@mineserver/shared";
import { createTempUpload } from "../addons.js";
import { instancePaths } from "../compose.js";
import { config } from "../config.js";
import type { AppContext } from "../app.js";
import { enforceTotalLimit, requireServer, rowConfig } from "../helpers.js";
import { resolveLevelName } from "../datapacks.js";
import { createWorldExport, importWorld, worldInfo } from "../worlds.js";

export async function worldsRoutes(
  app: FastifyInstance,
  context: AppContext,
): Promise<void> {
  const { store, docker, jobs } = context;

  app.get<{ Params: { id: string } }>(
    "/api/servers/:id/world",
    async (request) => {
      const row = requireServer(store, request.params.id);
      return worldInfo(
        row.id,
        instancePaths(config.instancesRoot, row.id),
        rowConfig(row),
        docker,
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/servers/:id/world/export",
    async (request, reply) => {
      const row = requireServer(store, request.params.id);
      const temp = await createTempUpload(config.tempRoot);
      temp.stream.end();
      await new Promise<void>((resolve, reject) => {
        temp.stream.once("close", resolve);
        temp.stream.once("error", reject);
      });
      await rm(temp.path, { force: true });
      const lease = jobs.mutations.acquire(row.id, "world-export");
      try {
        const exported = await createWorldExport(
          row.id,
          instancePaths(config.instancesRoot, row.id),
          rowConfig(row),
          docker,
          temp.path,
        );
        const info = await stat(temp.path);
        reply.header(
          "content-disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(`${row.slug}-${exported.filename}`)}`,
        );
        reply.header("content-length", String(info.size));
        reply.header("cache-control", "no-store, private, max-age=0");
        reply.header("x-content-type-options", "nosniff");
        reply.type("application/zip");
        const stream = createReadStream(temp.path);
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          lease.release();
          void rm(temp.path, { force: true });
        };
        stream.once("close", cleanup);
        stream.once("error", cleanup);
        reply.raw.once("close", cleanup);
        return reply.send(stream);
      } catch (error) {
        lease.release();
        await rm(temp.path, { force: true });
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/servers/:id/world/import",
    async (request, reply) => {
      const row = requireServer(store, request.params.id);
      const paths = instancePaths(config.instancesRoot, row.id);
      const currentLevelName = await resolveLevelName(
        paths.data,
        rowConfig(row),
      );
      const runtime = await docker.status(row.id, paths);
      if (runtime.state !== "stopped") {
        throw Object.assign(
          new Error("Stop the server before importing a world"),
          {
            statusCode: 409,
          },
        );
      }

      let upload: { path: string } | null = null;
      let fields: Record<string, string> = {};
      const limit = enforceTotalLimit();
      try {
        for await (const part of request.parts()) {
          if (part.type === "file") {
            if (upload) throw new Error("Choose exactly one world ZIP");
            if (!part.filename.toLowerCase().endsWith(".zip")) {
              throw new Error("Only ZIP world archives are accepted");
            }
            const temp = await createTempUpload(config.tempRoot);
            upload = { path: temp.path };
            await pipeline(part.file, limit(), temp.stream);
            if (part.file.truncated) {
              throw Object.assign(
                new Error("Upload exceeds the configured size limit"),
                { statusCode: 413 },
              );
            }
          } else {
            fields[part.fieldname] = String(part.value);
          }
        }
        if (!upload) throw new Error("Choose a world ZIP to import");
        const body = WorldImportSchema.parse({
          acknowledgeLevelName: fields.acknowledgeLevelName,
          overwrite: fields.overwrite === "true",
        });
        if (body.acknowledgeLevelName !== currentLevelName) {
          throw Object.assign(
            new Error(
              `The active world changed to ${currentLevelName}. Review the import again.`,
            ),
            { statusCode: 409 },
          );
        }
        const uploadPath = upload.path;
        const operation = jobs.runExclusive(
          row.id,
          "world-import",
          async () => {
            try {
              return await importWorld(
                row.id,
                uploadPath,
                paths,
                rowConfig(row),
                docker,
                body.acknowledgeLevelName,
              );
            } finally {
              await rm(uploadPath, { force: true });
            }
          },
        );
        upload = null;
        return reply.code(202).send(operation);
      } finally {
        if (upload) await rm(upload.path, { force: true });
      }
    },
  );
}
