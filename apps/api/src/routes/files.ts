import { pipeline } from "node:stream/promises";
import { rm } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import {
  ServerFileCreateSchema,
  ServerFileDeleteSchema,
  ServerFileMoveSchema,
} from "@mineserver/shared";
import {
  createServerFileEntry,
  deleteServerFileEntry,
  installServerFileUploads,
  listServerFiles,
  moveServerFileEntry,
  readServerFile,
  searchServerFiles,
  serverFileDownload,
  writeServerFile,
} from "../files.js";
import { createTempUpload } from "../addons.js";
import { instancePaths } from "../compose.js";
import { config } from "../config.js";
import type { AppContext } from "../app.js";
import { enforceTotalLimit, requireServer } from "../helpers.js";

export async function filesRoutes(
  app: FastifyInstance,
  context: AppContext,
): Promise<void> {
  const { store, jobs } = context;

  app.get<{
    Params: { id: string };
    Querystring: { path?: string };
  }>("/api/servers/:id/files", async (request) => {
    const row = requireServer(store, request.params.id);
    return listServerFiles(
      instancePaths(config.instancesRoot, row.id).data,
      request.query.path ?? "",
    );
  });

  app.get<{
    Params: { id: string };
    Querystring: { q?: string };
  }>("/api/servers/:id/files/search", async (request) => {
    const row = requireServer(store, request.params.id);
    const query = request.query.q?.trim() ?? "";
    if (!query || query.length > 200) throw new Error("Invalid search query");
    return searchServerFiles(
      instancePaths(config.instancesRoot, row.id).data,
      query,
    );
  });

  app.get<{
    Params: { id: string };
    Querystring: { path?: string };
  }>("/api/servers/:id/files/download", async (request, reply) => {
    const row = requireServer(store, request.params.id);
    if (!request.query.path) throw new Error("File path is required");
    const download = await serverFileDownload(
      instancePaths(config.instancesRoot, row.id).data,
      request.query.path,
    );
    reply.header(
      "content-disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(download.filename)}`,
    );
    reply.header("content-length", String(download.size));
    reply.header("x-content-type-options", "nosniff");
    reply.type("application/octet-stream");
    return reply.send(download.stream);
  });

  app.post<{
    Params: { id: string };
    Body: { parentPath?: string; name?: string; type?: string };
  }>("/api/servers/:id/files", async (request, reply) => {
    const row = requireServer(store, request.params.id);
    const { parentPath, name, type } = ServerFileCreateSchema.parse(
      request.body,
    );
    const entry = await jobs.mutations.runExclusive(row.id, "file-create", () =>
      createServerFileEntry(
        instancePaths(config.instancesRoot, row.id).data,
        parentPath,
        name,
        type,
      ),
    );
    return reply.code(201).send(entry);
  });

  app.post<{
    Params: { id: string };
    Querystring: { path?: string };
  }>("/api/servers/:id/files/upload", async (request, reply) => {
    const row = requireServer(store, request.params.id);
    const uploads: Array<{ path: string; originalName: string }> = [];
    const limit = enforceTotalLimit();
    try {
      for await (const file of request.files()) {
        const temp = await createTempUpload(config.tempRoot);
        uploads.push({ path: temp.path, originalName: file.filename });
        await pipeline(file.file, limit(), temp.stream);
        if (file.file.truncated)
          throw Object.assign(
            new Error("Upload exceeds the configured size limit"),
            { statusCode: 413 },
          );
      }
      if (uploads.length === 0) throw new Error("Choose one or more files");
      const files = await jobs.mutations.runExclusive(
        row.id,
        "file-upload",
        () =>
          installServerFileUploads(
            instancePaths(config.instancesRoot, row.id).data,
            request.query.path ?? "",
            uploads,
          ),
      );
      return reply.code(201).send({ files });
    } finally {
      await Promise.all(
        uploads.map((upload) => rm(upload.path, { force: true })),
      );
    }
  });

  app.patch<{
    Params: { id: string };
    Body: { path?: string; destinationPath?: string };
  }>("/api/servers/:id/files", async (request) => {
    const row = requireServer(store, request.params.id);
    const { path: sourcePath, destinationPath } = ServerFileMoveSchema.parse(
      request.body,
    );
    return jobs.mutations.runExclusive(row.id, "file-move", () =>
      moveServerFileEntry(
        instancePaths(config.instancesRoot, row.id).data,
        sourcePath,
        destinationPath,
      ),
    );
  });

  app.delete<{
    Params: { id: string };
    Querystring: { path?: string; expectedModifiedAt?: string };
  }>("/api/servers/:id/files", async (request, reply) => {
    const row = requireServer(store, request.params.id);
    const deletion = ServerFileDeleteSchema.parse(request.query);
    await jobs.mutations.runExclusive(row.id, "file-delete", () =>
      deleteServerFileEntry(
        instancePaths(config.instancesRoot, row.id).data,
        deletion.path,
        deletion.expectedModifiedAt,
      ),
    );
    return reply.code(204).send();
  });

  app.get<{
    Params: { id: string };
    Querystring: { path?: string };
  }>("/api/servers/:id/files/content", async (request) => {
    const row = requireServer(store, request.params.id);
    if (!request.query.path) throw new Error("File path is required");
    return readServerFile(
      instancePaths(config.instancesRoot, row.id).data,
      request.query.path,
      config.MAX_EDIT_FILE_BYTES,
    );
  });

  app.put<{
    Params: { id: string };
    Body: {
      path?: string;
      content?: string;
      expectedModifiedAt?: string;
    };
  }>("/api/servers/:id/files/content", async (request) => {
    const row = requireServer(store, request.params.id);
    const { path: filePath, content, expectedModifiedAt } = request.body ?? {};
    if (
      typeof filePath !== "string" ||
      typeof content !== "string" ||
      (expectedModifiedAt !== undefined &&
        typeof expectedModifiedAt !== "string")
    ) {
      throw new Error("Invalid file update");
    }
    return jobs.mutations.runExclusive(row.id, "file-write", () =>
      writeServerFile(
        instancePaths(config.instancesRoot, row.id).data,
        filePath,
        content,
        expectedModifiedAt,
        config.MAX_EDIT_FILE_BYTES,
      ),
    );
  });
}
