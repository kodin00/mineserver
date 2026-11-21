import { BlockList, isIPv4 } from "node:net";
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
    session?: { hash: string; csrf: string; role: "admin" | "player" };
  }
}

// Fastify 5.12.5+ ignores numeric (hop-count-only) trustProxy values, because
// they let a direct client spoof X-Forwarded-For. Trust only the first
// TRUST_PROXY_HOPS hops, and only when they come from a loopback or private
// address, such as the bundled nginx on the Compose network.
const privateNetworks = new BlockList();
for (const [network, prefix, type] of [
  ["127.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
] as const) {
  privateNetworks.addSubnet(network, prefix, type);
}

export function isTrustedProxyAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const ip = mapped ?? address;
  try {
    return privateNetworks.check(ip, isIPv4(ip) ? "ipv4" : "ipv6");
  } catch {
    return false;
  }
}

function trustProxySetting(hops: number) {
  if (hops <= 0) return false;
  return (address: string, hop: number) =>
    hop < hops && isTrustedProxyAddress(address);
}

export async function buildApp(
  context: AppContext,
): Promise<{ app: FastifyInstance; jobs: JobRunner }> {
  const { store, docker, jobs } = context;
  const app = Fastify({
    trustProxy: trustProxySetting(config.TRUST_PROXY_HOPS),
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
    const explicitStatus = (error as { statusCode?: unknown }).statusCode;
    const isValidation =
      typeof error === "object" &&
      error !== null &&
      Array.isArray((error as { issues?: unknown }).issues);
    // Only errors explicitly classified with an HTTP status (or schema
    // validation failures) may expose their message. Anything else, such as
    // SQLite or filesystem errors, is logged and answered generically.
    const classified =
      typeof explicitStatus === "number" &&
      explicitStatus >= 400 &&
      explicitStatus < 600;
    const status = classified ? explicitStatus : isValidation ? 400 : 500;
    const details = {
      err: error,
      method: request.method,
      url: request.url,
      statusCode: status,
    };
    if (status >= 500) request.log.error(details, "Request failed");
    else request.log.warn(details, "Request rejected");
    reply.code(status).send({
      error:
        classified || isValidation
          ? errorMessage(error)
          : "Internal server error",
    });
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
    if (request.session?.role === "player") {
      const get = request.method === "GET";
      const allowed =
        (get &&
          (pathname === "/api/auth/me" ||
            pathname === "/api/metadata" ||
            pathname === "/api/servers" ||
            /^\/api\/servers\/[^/]+(?:\/mod-requests)?$/.test(pathname) ||
            pathname === "/api/modrinth/tags" ||
            pathname === "/api/modrinth/search" ||
            /^\/api\/modrinth\/projects\/[^/]+\/versions$/.test(pathname))) ||
        (request.method === "POST" &&
          (pathname === "/api/auth/logout" ||
            /^\/api\/servers\/[^/]+\/mod-requests$/.test(pathname)));
      if (!allowed)
        return reply.code(403).send({ error: "Administrator access required" });
    }
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
