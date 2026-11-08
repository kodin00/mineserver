import { Transform } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  ServerConfigSchema,
  type ServerConfig,
  type ServerSummary,
} from "@mineserver/shared";
import { instancePaths } from "./compose.js";
import { config } from "./config.js";
import { Store, type ServerRow } from "./db.js";
import type { ComposeManager } from "./docker.js";
import { slugify, sha256 } from "./utils.js";

export const SESSION_COOKIE = "ms_session";
export const CSRF_COOKIE = "ms_csrf";

export function rowConfig(row: ServerRow): ServerConfig {
  return ServerConfigSchema.parse(JSON.parse(row.config_json));
}

export function uniqueSlug(store: Store, name: string): string {
  const used = new Set(store.listServers().map((row) => row.slug));
  const base = slugify(name);
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export async function serverSummary(
  row: ServerRow,
  docker: ComposeManager,
): Promise<ServerSummary> {
  const serverConfig = rowConfig(row);
  const runtime = await docker.status(
    row.id,
    instancePaths(config.instancesRoot, row.id),
    serverConfig.autoSleep.enabled,
  );
  return {
    id: row.id,
    slug: row.slug,
    config: serverConfig,
    revision: row.revision,
    appliedRevision: row.applied_revision,
    restartRequired: row.revision !== row.applied_revision,
    state: runtime.state,
    containerExists: runtime.exists,
    ...(runtime.wakeProxyRunning !== undefined
      ? { wakeProxyRunning: runtime.wakeProxyRunning }
      : {}),
    ...(runtime.health ? { health: runtime.health } : {}),
    ...(runtime.runtimeError ? { runtimeError: runtime.runtimeError } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function authenticate(
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

export function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "issues" in error) {
    return (error as any).issues.map((issue: any) => issue.message).join(", ");
  }
  return error instanceof Error ? error.message : String(error);
}

export function requireServer(store: Store, id: string): ServerRow {
  const row = store.getServer(id);
  if (!row)
    throw Object.assign(new Error("Server not found"), { statusCode: 404 });
  return row;
}

export function enforceTotalLimit(): () => Transform {
  // A single counter per request: the original inline Transform captured
  // `totalBytes` in the handler scope, so the limit spans every file in the
  // same multipart upload, not each file individually.
  let totalBytes = 0;
  return () =>
    new Transform({
      transform(chunk, _encoding, callback) {
        totalBytes += chunk.length;
        if (totalBytes > config.MAX_UPLOAD_BYTES) {
          callback(
            Object.assign(
              new Error("Upload exceeds the configured size limit"),
              {
                statusCode: 413,
              },
            ),
          );
        } else {
          callback(null, chunk);
        }
      },
    });
}
