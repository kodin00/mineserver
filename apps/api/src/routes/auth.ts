import type { FastifyInstance } from "fastify";
import type { Operation } from "@mineserver/shared";
import {
  ChangePasswordSchema,
  LoginSchema,
  addonKind,
} from "@mineserver/shared";
import { z } from "zod";
import { hash, verify } from "@node-rs/argon2";
import { createAddonsArchive } from "../addons.js";
import { instancePaths } from "../compose.js";
import { config } from "../config.js";
import type { AppContext } from "../app.js";
import { CSRF_COOKIE, SESSION_COOKIE, rowConfig } from "../helpers.js";
import { randomToken, sha256 } from "../utils.js";

export async function authRoutes(
  app: FastifyInstance,
  context: AppContext,
): Promise<void> {
  const { store, jobs } = context;

  const logFailedOperation = (operation: unknown) => {
    const value = operation as Operation;
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
      const credential =
        body.role === "admin"
          ? store.getAdmin()?.password_hash
          : store.getPlayerAccess().enabled
            ? store.getPlayerAccess().password_hash
            : null;
      if (!credential || !(await verify(credential, body.password))) {
        return reply.code(401).send({ error: "Invalid password" });
      }
      // Password verification is asynchronous. A rotation or disablement that
      // finishes while it runs must not be followed by a new stale session.
      const playerAccess = store.getPlayerAccess();
      const currentCredential =
        body.role === "admin"
          ? store.getAdmin()?.password_hash
          : playerAccess.enabled
            ? playerAccess.password_hash
            : null;
      if (currentCredential !== credential) {
        return reply.code(401).send({ error: "Invalid password" });
      }
      const token = randomToken();
      const csrf = randomToken(24);
      const expires = new Date(
        Date.now() + config.SESSION_TTL_HOURS * 60 * 60 * 1000,
      );
      store.createSession(
        sha256(token),
        csrf,
        expires.toISOString(),
        body.role,
      );
      const cookieBase = {
        path: "/",
        sameSite: "strict" as const,
        secure: config.COOKIE_SECURE,
        expires,
      };
      reply.setCookie(SESSION_COOKIE, token, { ...cookieBase, httpOnly: true });
      reply.setCookie(CSRF_COOKIE, csrf, { ...cookieBase, httpOnly: false });
      return { authenticated: true, csrfToken: csrf, role: body.role };
    },
  );

  app.get("/api/auth/me", async (request) => ({
    authenticated: true,
    csrfToken: request.session!.csrf,
    role: request.session!.role,
  }));

  app.post("/api/auth/logout", async (request, reply) => {
    if (request.session) store.deleteSession(request.session.hash);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(CSRF_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/player-access", async () => {
    const access = store.getPlayerAccess();
    return {
      enabled: access.enabled === 1,
      hasPassword: !!access.password_hash,
    };
  });
  app.put("/api/auth/player-access", async (request) => {
    const body = z
      .object({
        enabled: z.boolean(),
        password: z.string().min(12).max(512).optional(),
      })
      .parse(request.body);
    const previous = store.getPlayerAccess();
    const passwordHash = body.password
      ? await hash(body.password)
      : previous.password_hash;
    if (body.enabled && !passwordHash)
      throw new Error("Set a player password before enabling access");
    store.setPlayerAccess(body.enabled, passwordHash);
    return { enabled: body.enabled, hasPassword: !!passwordHash };
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
}
