import path from "node:path";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { hash, verify } from "@node-rs/argon2";
import {
  ChangePasswordSchema,
  ConsoleCommandSchema,
  CreateServerSchema,
  LoginSchema,
  ServerConfigSchema,
  addonKind,
  type ServerConfig,
  type ServerSummary,
} from "@mineserver/shared";
import {
  addonFilePath,
  createAddonsArchive,
  createTempUpload,
  ensureAddonsReadable,
  installAddonBatch,
  listAddons,
  removeAddon,
  setAddonEnabled,
} from "./addons.js";
import {
  createBackup,
  listBackups,
  removeBackup,
  restoreBackup,
} from "./backups.js";
import { BackupScheduler } from "./backup-scheduler.js";
import { instancePaths, writeCompose } from "./compose.js";
import { config } from "./config.js";
import { Store, type ServerRow } from "./db.js";
import { ComposeManager } from "./docker.js";
import { JobRunner } from "./jobs.js";
import {
  listServerFiles,
  readServerFile,
  searchServerFiles,
  writeServerFile,
} from "./files.js";
import {
  pathExists,
  randomToken,
  safeFilename,
  sha256,
  slugify,
} from "./utils.js";

const SESSION_COOKIE = "ms_session";
const CSRF_COOKIE = "ms_csrf";

interface AppContext {
  store: Store;
  docker: ComposeManager;
  jobs: JobRunner;
}

declare module "fastify" {
  interface FastifyRequest {
    session?: { hash: string; csrf: string };
  }
}

function rowConfig(row: ServerRow): ServerConfig {
  return ServerConfigSchema.parse(JSON.parse(row.config_json));
}

function uniqueSlug(store: Store, name: string): string {
  const used = new Set(store.listServers().map((row) => row.slug));
  const base = slugify(name);
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

async function serverSummary(
  row: ServerRow,
  docker: ComposeManager,
): Promise<ServerSummary> {
  const runtime = await docker.status(
    row.id,
    instancePaths(config.instancesRoot, row.id),
  );
  return {
    id: row.id,
    slug: row.slug,
    config: rowConfig(row),
    revision: row.revision,
    appliedRevision: row.applied_revision,
    restartRequired: row.revision !== row.applied_revision,
    state: runtime.state,
    containerExists: runtime.exists,
    ...(runtime.health ? { health: runtime.health } : {}),
    ...(runtime.runtimeError ? { runtimeError: runtime.runtimeError } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  store: Store,
) {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) {
    return reply.code(401).send({ error: "Authentication required" });
  }
  const tokenHash = sha256(token);
  const session = store.getSession(tokenHash);
  if (!session || session.expires_at < new Date().toISOString()) {
    if (session) store.deleteSession(tokenHash);
    return reply.code(401).send({ error: "Session expired" });
  }
  request.session = { hash: tokenHash, csrf: session.csrf_token };
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "issues" in error) {
    return (error as any).issues.map((issue: any) => issue.message).join(", ");
  }
  return error instanceof Error ? error.message : String(error);
}

async function fetchMetadata() {
  const [versions, images] = await Promise.allSettled([
    fetch(
      "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
    ).then((res) => {
      if (!res.ok) throw new Error("Version service unavailable");
      return res.json();
    }),
    fetch(
      "https://raw.githubusercontent.com/itzg/docker-minecraft-server/refs/heads/master/images.json",
    ).then((res) => {
      if (!res.ok) throw new Error("Image metadata unavailable");
      return res.json();
    }),
  ]);
  return {
    versions:
      versions.status === "fulfilled"
        ? ((versions.value as any).versions?.slice(0, 100) ?? [])
        : [],
    imageTags: images.status === "fulfilled" ? images.value : null,
  };
}

export async function buildApp(context: AppContext) {
  const { store, docker, jobs } = context;
  const app = Fastify({
    trustProxy: config.TRUST_PROXY_HOPS > 0 ? config.TRUST_PROXY_HOPS : false,
    logger: {
      level: config.NODE_ENV === "test" ? "silent" : "info",
    },
    bodyLimit: 2 * 1024 * 1024,
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(multipart, {
    limits: {
      fileSize: config.MAX_UPLOAD_BYTES,
      files: config.MAX_UPLOAD_FILES,
      fields: 2,
    },
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  const backupScheduler = new BackupScheduler(store, docker, jobs);
  if (config.NODE_ENV !== "test") backupScheduler.start();
  app.addHook("onClose", async () => backupScheduler.stop());

  app.setErrorHandler((error, request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    const status =
      (error as any).statusCode ?? (/not found/i.test(message) ? 404 : 400);
    const details = {
      err: error,
      method: request.method,
      url: request.url,
      statusCode: status,
    };
    if (status >= 500) request.log.error(details, "Request failed");
    else request.log.warn(details, "Request rejected");
    reply.code(status).send({ error: errorMessage(error) });
  });

  const logFailedOperation = (operation: unknown) => {
    const value = operation as import("@mineserver/shared").Operation;
    if (value.status === "failed") {
      app.log.error(
        {
          operationId: value.id,
          serverId: value.serverId,
          kind: value.kind,
          error: value.message,
        },
        "Server operation failed",
      );
    }
  };
  jobs.on("operation", logFailedOperation);
  app.addHook("onClose", async () => jobs.off("operation", logFailedOperation));

  app.addHook("preHandler", async (request, reply) => {
    const pathname = request.url.split("?")[0]!;
    if (
      pathname === "/api/health" ||
      pathname === "/api/auth/login" ||
      pathname.startsWith("/api/public/")
    )
      return;
    if (!pathname.startsWith("/api/") && !pathname.startsWith("/ws/")) return;
    const authResult = await authenticate(request, reply, store);
    if (authResult) return authResult;
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      pathname.startsWith("/api/")
    ) {
      const token = request.headers["x-csrf-token"];
      if (typeof token !== "string" || token !== request.session?.csrf) {
        return reply.code(403).send({ error: "Invalid CSRF token" });
      }
    }
  });

  app.get("/api/health", async () => ({ status: "ok" }));

  app.head(
    "/api/public/addons/:token",
    {
      config: {
        rateLimit: {
          max: config.PUBLIC_DOWNLOAD_RATE_LIMIT,
          timeWindow: "1 minute",
        },
      },
    },
    async (_request, reply) => {
      reply.header("cache-control", "no-store, private, max-age=0");
      return reply.code(405).header("allow", "GET").send();
    },
  );

  app.get<{ Params: { token: string } }>(
    "/api/public/addons/:token",
    {
      config: {
        rateLimit: {
          max: config.PUBLIC_DOWNLOAD_RATE_LIMIT,
          timeWindow: "1 minute",
        },
      },
    },
    async (request, reply) => {
      const token = request.params.token;
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
        return reply.code(404).send({ error: "Download link not found" });
      }
      const share = store.claimAddonShare(sha256(token));
      if (!share) {
        return reply.code(404).send({ error: "Download link not found" });
      }
      const row = store.getServer(share.server_id);
      if (!row) {
        return reply.code(404).send({ error: "Download link not found" });
      }
      const kind = addonKind(rowConfig(row).type);
      if (!kind) {
        return reply.code(404).send({ error: "Download link not found" });
      }
      const archive = await createAddonsArchive(
        instancePaths(config.instancesRoot, row.id).addons,
      );
      reply.headers({
        "cache-control": "no-store, private, max-age=0",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${row.slug}-${kind}.zip`)}`,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      reply.type("application/zip");
      return reply.send(archive);
    },
  );

  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = LoginSchema.parse(request.body);
      const admin = store.getAdmin();
      if (!admin || !(await verify(admin.password_hash, body.password))) {
        return reply.code(401).send({ error: "Invalid password" });
      }
      const token = randomToken();
      const csrf = randomToken(24);
      const expires = new Date(
        Date.now() + config.SESSION_TTL_HOURS * 60 * 60 * 1000,
      );
      store.createSession(sha256(token), csrf, expires.toISOString());
      const cookieBase = {
        path: "/",
        sameSite: "strict" as const,
        secure: config.COOKIE_SECURE,
        expires,
      };
      reply.setCookie(SESSION_COOKIE, token, { ...cookieBase, httpOnly: true });
      reply.setCookie(CSRF_COOKIE, csrf, { ...cookieBase, httpOnly: false });
      return { authenticated: true, csrfToken: csrf };
    },
  );

  app.get("/api/auth/me", async (request) => ({
    authenticated: true,
    csrfToken: request.session!.csrf,
  }));

  app.post("/api/auth/logout", async (request, reply) => {
    if (request.session) store.deleteSession(request.session.hash);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(CSRF_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post("/api/auth/password", async (request) => {
    const body = ChangePasswordSchema.parse(request.body);
    const admin = store.getAdmin();
    if (!admin || !(await verify(admin.password_hash, body.currentPassword))) {
      throw Object.assign(new Error("Current password is incorrect"), {
        statusCode: 403,
      });
    }
    store.updatePassword(await hash(body.newPassword));
    return { ok: true, reloginRequired: true };
  });

  let metadataCache: { value: any; expires: number } | null = null;
  app.get("/api/metadata", async () => {
    if (!metadataCache || metadataCache.expires < Date.now()) {
      metadataCache = {
        value: await fetchMetadata(),
        expires: Date.now() + 60 * 60_000,
      };
    }
    return metadataCache.value;
  });

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
    const row = store.getServer(request.params.id);
    if (!row)
      throw Object.assign(new Error("Server not found"), { statusCode: 404 });
    return serverSummary(row, docker);
  });

  app.put<{ Params: { id: string } }>("/api/servers/:id", async (request) => {
    const row = store.getServer(request.params.id);
    if (!row)
      throw Object.assign(new Error("Server not found"), { statusCode: 404 });
    const serverConfig = ServerConfigSchema.parse(request.body);
    if (store.getServerByPort(serverConfig.port, row.id)) {
      throw Object.assign(
        new Error(`Port ${serverConfig.port} is already assigned`),
        {
          statusCode: 409,
        },
      );
    }
    store.updateServer(row.id, serverConfig);
    await writeCompose(
      row.id,
      serverConfig,
      instancePaths(config.instancesRoot, row.id),
    );
    return serverSummary(store.getServer(row.id)!, docker);
  });

  app.post<{
    Params: { id: string; action: string };
  }>("/api/servers/:id/actions/:action", async (request, reply) => {
    const row = store.getServer(request.params.id);
    if (!row)
      throw Object.assign(new Error("Server not found"), { statusCode: 404 });
    const paths = instancePaths(config.instancesRoot, row.id);
    const action = request.params.action;
    const operation = jobs.run(row.id, action, async () => {
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
      const row = store.getServer(request.params.id);
      if (!row)
        throw Object.assign(new Error("Server not found"), { statusCode: 404 });
      return docker.stats(row.id, instancePaths(config.instancesRoot, row.id));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/servers/:id/addons/share",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const row = store.getServer(request.params.id);
      if (!row)
        throw Object.assign(new Error("Server not found"), {
          statusCode: 404,
        });
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
      const row = store.getServer(request.params.id);
      if (!row)
        throw Object.assign(new Error("Server not found"), { statusCode: 404 });
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
      const row = store.getServer(request.params.id);
      if (!row)
        throw Object.assign(new Error("Server not found"), { statusCode: 404 });
      const body = ConsoleCommandSchema.parse(request.body);
      const result = await docker.console(
        row.id,
        instancePaths(config.instancesRoot, row.id),
        body.command,
      );
      return { output: result.stdout.trim() };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/servers/:id/addons",
    async (request) => {
      const row = store.getServer(request.params.id);
      if (!row)
        throw Object.assign(new Error("Server not found"), { statusCode: 404 });
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
      const row = store.getServer(request.params.id);
      if (!row)
        throw Object.assign(new Error("Server not found"), { statusCode: 404 });
      const kind = addonKind(rowConfig(row).type);
      if (!kind)
        throw new Error("This server type does not support managed add-ons");
      const uploads: Array<{ path: string; originalName: string }> = [];
      let totalBytes = 0;
      try {
        for await (const file of request.files()) {
          const temp = await createTempUpload(config.tempRoot);
          uploads.push({ path: temp.path, originalName: file.filename });
          const enforceTotalLimit = new Transform({
            transform(chunk, _encoding, callback) {
              totalBytes += chunk.length;
              if (totalBytes > config.MAX_UPLOAD_BYTES) {
                callback(
                  Object.assign(
                    new Error("Upload exceeds the configured size limit"),
                    { statusCode: 413 },
                  ),
                );
              } else {
                callback(null, chunk);
              }
            },
          });
          await pipeline(file.file, enforceTotalLimit, temp.stream);
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
        const installed = await installAddonBatch(uploads, directory);
        store.touchServerRevision(row.id);
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
      const row = store.getServer(request.params.id);
      if (!row)
        throw Object.assign(new Error("Server not found"), {
          statusCode: 404,
        });
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
      const row = store.getServer(request.params.id);
      if (!row)
        throw Object.assign(new Error("Server not found"), {
          statusCode: 404,
        });
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
    const row = store.getServer(request.params.id);
    if (!row)
      throw Object.assign(new Error("Server not found"), { statusCode: 404 });
    const enabled = Boolean((request.body as any)?.enabled);
    await setAddonEnabled(
      instancePaths(config.instancesRoot, row.id).addons,
      decodeURIComponent(request.params.filename),
      enabled,
    );
    store.touchServerRevision(row.id);
    return { ok: true, restartRequired: true };
  });

  app.delete<{
    Params: { id: string; filename: string };
  }>("/api/servers/:id/addons/:filename", async (request) => {
    const row = store.getServer(request.params.id);
    if (!row)
      throw Object.assign(new Error("Server not found"), { statusCode: 404 });
    await removeAddon(
      instancePaths(config.instancesRoot, row.id).addons,
      decodeURIComponent(request.params.filename),
    );
    store.touchServerRevision(row.id);
    return { ok: true, restartRequired: true };
  });

  app.get<{ Params: { id: string } }>(
    "/api/servers/:id/backups",
    async (request) => {
      const row = store.getServer(request.params.id);
      if (!row)
        throw Object.assign(new Error("Server not found"), { statusCode: 404 });
      return listBackups(instancePaths(config.instancesRoot, row.id).backups);
    },
  );

  app.get<{ Params: { id: string; filename: string } }>(
    "/api/servers/:id/backups/:filename/download",
    async (request, reply) => {
      const row = store.getServer(request.params.id);
      if (!row)
        throw Object.assign(new Error("Server not found"), { statusCode: 404 });
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
      const row = store.getServer(request.params.id);
      if (!row)
        throw Object.assign(new Error("Server not found"), { statusCode: 404 });
      const filename = decodeURIComponent(request.params.filename);
      const paths = instancePaths(config.instancesRoot, row.id);
      const operation = jobs.run(row.id, "restore", () =>
        restoreBackup(row.id, filename, paths, docker),
      );
      return reply.code(202).send(operation);
    },
  );

  app.delete<{ Params: { id: string; filename: string } }>(
    "/api/servers/:id/backups/:filename",
    async (request) => {
      const row = store.getServer(request.params.id);
      if (!row)
        throw Object.assign(new Error("Server not found"), { statusCode: 404 });
      await removeBackup(
        instancePaths(config.instancesRoot, row.id).backups,
        decodeURIComponent(request.params.filename),
      );
      return { ok: true };
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { path?: string };
  }>("/api/servers/:id/files", async (request) => {
    const row = store.getServer(request.params.id);
    if (!row)
      throw Object.assign(new Error("Server not found"), { statusCode: 404 });
    return listServerFiles(
      instancePaths(config.instancesRoot, row.id).data,
      request.query.path ?? "",
    );
  });

  app.get<{
    Params: { id: string };
    Querystring: { q?: string };
  }>("/api/servers/:id/files/search", async (request) => {
    const row = store.getServer(request.params.id);
    if (!row)
      throw Object.assign(new Error("Server not found"), { statusCode: 404 });
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
  }>("/api/servers/:id/files/content", async (request) => {
    const row = store.getServer(request.params.id);
    if (!row)
      throw Object.assign(new Error("Server not found"), { statusCode: 404 });
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
    const row = store.getServer(request.params.id);
    if (!row)
      throw Object.assign(new Error("Server not found"), { statusCode: 404 });
    const { path: filePath, content, expectedModifiedAt } = request.body ?? {};
    if (
      typeof filePath !== "string" ||
      typeof content !== "string" ||
      (expectedModifiedAt !== undefined &&
        typeof expectedModifiedAt !== "string")
    ) {
      throw new Error("Invalid file update");
    }
    return writeServerFile(
      instancePaths(config.instancesRoot, row.id).data,
      filePath,
      content,
      expectedModifiedAt,
      config.MAX_EDIT_FILE_BYTES,
    );
  });

  app.get<{ Params: { id: string } }>(
    "/api/servers/:id/operations",
    async (request) => {
      if (!store.getServer(request.params.id))
        throw Object.assign(new Error("Server not found"), { statusCode: 404 });
      return store.listOperations(request.params.id);
    },
  );

  app.delete<{
    Params: { id: string };
    Querystring: { permanent?: string };
  }>("/api/servers/:id", async (request) => {
    const row = store.getServer(request.params.id);
    if (!row)
      throw Object.assign(new Error("Server not found"), { statusCode: 404 });
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

  return app;
}

export async function createContext(): Promise<AppContext> {
  await Promise.all([
    mkdir(config.DATA_ROOT, { recursive: true }),
    mkdir(config.instancesRoot, { recursive: true }),
    mkdir(config.tempRoot, { recursive: true }),
  ]);
  const store = new Store(config.databasePath);
  if (!store.getAdmin()) store.createAdmin(await hash(config.ADMIN_PASSWORD));
  store.pruneSessions();
  store.pruneAddonShares();
  const docker = new ComposeManager();
  for (const row of store.listServers()) {
    const paths = instancePaths(config.instancesRoot, row.id);
    const composeContents = (await pathExists(paths.compose))
      ? await readFile(paths.compose, "utf8")
      : "";
    const needsBackupMigration = composeContents.includes("itzg/mc-backup");
    const needsRestartPolicyMigration = composeContents.includes(
      "restart: unless-stopped",
    );
    if (needsBackupMigration) {
      store.touchServerRevision(row.id);
      await writeFile(paths.backupMigrationMarker, "apply required\n", {
        mode: 0o600,
      });
    }
    if (needsBackupMigration || needsRestartPolicyMigration) {
      await writeCompose(row.id, rowConfig(row), paths);
    }
    if (needsRestartPolicyMigration) {
      await docker.enforceRestartLimit(row.id, paths).catch((error) => {
        console.error(
          `[mineserver] Could not update restart policy for ${row.id}:`,
          error,
        );
      });
    }
  }
  return { store, docker, jobs: new JobRunner(store) };
}
