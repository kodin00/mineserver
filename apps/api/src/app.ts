import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { JobRunner } from "./jobs.js";
import { Store } from "./db.js";
import { ComposeManager } from "./docker.js";
import type { ModrinthApi } from "./modrinth.js";
import { BackupScheduler } from "./backup-scheduler.js";
import { config } from "./config.js";
import { errorMessage, authenticate } from "./helpers.js";
import { addonsRoutes } from "./routes/addons.js";
import { authRoutes } from "./routes/auth.js";
import { backupsRoutes } from "./routes/backups.js";
import { consoleRoutes } from "./routes/console.js";
import { filesRoutes } from "./routes/files.js";
import { marketplaceRoutes } from "./routes/marketplace.js";
import { serversRoutes } from "./routes/servers.js";
import { worldsRoutes } from "./routes/worlds.js";

export interface AppContext {
  store: Store;
  docker: ComposeManager;
  jobs: JobRunner;
  modrinth: ModrinthApi;
}

declare module "fastify" {
  interface FastifyRequest {
    session?: { hash: string; csrf: string };
  }
}

export async function buildApp(
  context: AppContext,
): Promise<{ app: FastifyInstance; jobs: JobRunner }> {
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
      (error as { statusCode?: number }).statusCode ??
      (/not found/i.test(message) ? 404 : 400);
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

  // Root-level so the authentication and CSRF checks apply to every route
  // plugin, matching the semantics of the pre-split monolith.
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

  await app.register(authRoutes, context);
  await app.register(serversRoutes, context);
  await app.register(consoleRoutes, context);
  await app.register(addonsRoutes, context);
  await app.register(marketplaceRoutes, context);
  await app.register(worldsRoutes, context);
  await app.register(backupsRoutes, context);
  await app.register(filesRoutes, context);

  return { app, jobs };
}
