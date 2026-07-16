import path from "node:path";
import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ServerConfigSchema } from "@mineserver/shared";
import { listAddons } from "./addons.js";
import { buildApp } from "./app.js";
import { instancePaths } from "./compose.js";
import { config } from "./config.js";
import { Store } from "./db.js";
import type { ComposeManager } from "./docker.js";
import { JobRunner } from "./jobs.js";
import { sha256 } from "./utils.js";

const roots: string[] = [];
const originalInstancesRoot = config.instancesRoot;
const originalTempRoot = config.tempRoot;
const originalMaxUploadBytes = config.MAX_UPLOAD_BYTES;

function multipart(files: Array<{ name: string; contents: string }>) {
  const boundary = "----mineserver-test-boundary";
  const chunks: Buffer[] = [];
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from(file.contents),
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function fixture(docker: ComposeManager = {} as ComposeManager) {
  const root = await mkdtemp(path.join(tmpdir(), "mineserver-share-"));
  roots.push(root);
  config.instancesRoot = path.join(root, "instances");
  config.tempRoot = path.join(root, "temp");
  const store = new Store(path.join(root, "panel.sqlite"));
  const serverId = "server-1";
  store.insertServer(
    serverId,
    "test-server",
    ServerConfigSchema.parse({ name: "Test server", type: "FABRIC" }),
  );
  const addons = instancePaths(config.instancesRoot, serverId).addons;
  await mkdir(addons, { recursive: true });
  await writeFile(path.join(addons, "example-mod.jar"), "jar contents");

  const sessionToken = "test-session";
  const csrfToken = "test-csrf";
  store.createSession(
    sha256(sessionToken),
    csrfToken,
    new Date(Date.now() + 60_000).toISOString(),
  );
  const app = await buildApp({
    store,
    docker,
    jobs: new JobRunner(store),
  });
  return { app, store, serverId, sessionToken, csrfToken };
}

describe("server lifecycle actions", () => {
  it("runs an existing container without applying changes and rebuilds only on confirmation action", async () => {
    const calls: string[] = [];
    const docker = {
      status: async () => ({ state: "stopped" as const, exists: true }),
      startExisting: async () => {
        calls.push("run");
      },
      rebuild: async () => {
        calls.push("rebuild");
      },
    } as unknown as ComposeManager;
    const { app, store, serverId, sessionToken, csrfToken } =
      await fixture(docker);
    const headers = {
      cookie: `ms_session=${sessionToken}`,
      "x-csrf-token": csrfToken,
    };
    store.markApplied(serverId);
    store.touchServerRevision(serverId);
    const existingAddon = path.join(
      instancePaths(config.instancesRoot, serverId).addons,
      "example-mod.jar",
    );
    await chmod(existingAddon, 0o600);

    const run = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/actions/run`,
      headers,
    });
    expect(run.statusCode).toBe(202);
    await expect
      .poll(
        () =>
          store.listOperations(serverId).find((item) => item.kind === "run")
            ?.status,
      )
      .toBe("succeeded");
    expect(store.getServer(serverId)?.applied_revision).toBe(1);
    expect((await stat(existingAddon)).mode & 0o777).toBe(0o644);

    const rebuild = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/actions/rebuild`,
      headers,
    });
    expect(rebuild.statusCode).toBe(202);
    await expect
      .poll(
        () =>
          store.listOperations(serverId).find((item) => item.kind === "rebuild")
            ?.status,
      )
      .toBe("succeeded");
    expect(calls).toEqual(["run", "rebuild"]);
    expect(store.getServer(serverId)?.applied_revision).toBe(2);

    await app.close();
    store.db.close();
  });
});

describe("Docker logs", () => {
  it("returns retained logs and clamps oversized tail requests", async () => {
    let requestedTail: number | undefined;
    const docker = {
      logs: async (_id: string, _paths: unknown, tail: number | undefined) => {
        requestedTail = tail;
        return {
          stdout: "2026-07-16T12:00:00Z server stopped\n",
          stderr: "",
          code: 0,
        };
      },
    } as unknown as ComposeManager;
    const { app, store, serverId, sessionToken } = await fixture(docker);

    const response = await app.inject({
      method: "GET",
      url: `/api/servers/${serverId}/logs?tail=999999`,
      headers: { cookie: `ms_session=${sessionToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(requestedTail).toBe(5000);
    expect(response.json()).toEqual({
      logs: "2026-07-16T12:00:00Z server stopped\n",
    });

    await app.close();
    store.db.close();
  });
});

afterEach(async () => {
  config.instancesRoot = originalInstancesRoot;
  config.tempRoot = originalTempRoot;
  config.MAX_UPLOAD_BYTES = originalMaxUploadBytes;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("one-time public add-on downloads", () => {
  it("streams one ZIP without authentication and rejects every reuse", async () => {
    const { app, store, serverId, sessionToken, csrfToken } = await fixture();
    const created = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/addons/share`,
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
    });
    expect(created.statusCode).toBe(201);
    const { path: publicPath } = created.json<{ path: string }>();

    const head = await app.inject({ method: "HEAD", url: publicPath });
    expect(head.statusCode).toBe(405);

    const attempts = await Promise.all([
      app.inject({ method: "GET", url: publicPath }),
      app.inject({ method: "GET", url: publicPath }),
    ]);
    const success = attempts.find((response) => response.statusCode === 200);
    const rejected = attempts.find((response) => response.statusCode === 404);
    expect(success).toBeDefined();
    expect(rejected?.json()).toEqual({ error: "Download link not found" });
    expect(success?.headers["content-type"]).toContain("application/zip");
    expect(success?.headers["cache-control"]).toContain("no-store");
    expect(success?.rawPayload.subarray(0, 2).toString()).toBe("PK");
    expect(success?.headers["x-ratelimit-limit"]).toBeDefined();

    await app.close();
    store.db.close();
  });
});

describe("multiple add-on uploads", () => {
  it("installs multiple JARs in one request and rolls back failed batches", async () => {
    const { app, store, serverId, sessionToken, csrfToken } = await fixture();
    const headers = {
      cookie: `ms_session=${sessionToken}`,
      "x-csrf-token": csrfToken,
    };
    const first = multipart([
      { name: "alpha.jar", contents: "alpha" },
      { name: "beta.jar", contents: "beta" },
    ]);
    const installed = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/addons`,
      headers: { ...headers, "content-type": first.contentType },
      payload: first.payload,
    });
    expect(installed.statusCode).toBe(201);
    expect(installed.json()).toMatchObject({
      installed: ["alpha.jar", "beta.jar"],
      restartRequired: true,
    });
    const addonsDirectory = instancePaths(
      config.instancesRoot,
      serverId,
    ).addons;
    expect(
      (await stat(path.join(addonsDirectory, "alpha.jar"))).mode & 0o777,
    ).toBe(0o644);
    expect(
      (await stat(path.join(addonsDirectory, "beta.jar"))).mode & 0o777,
    ).toBe(0o644);

    const second = multipart([
      { name: "gamma.jar", contents: "gamma" },
      { name: "alpha.jar", contents: "duplicate" },
    ]);
    const rejected = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/addons`,
      headers: { ...headers, "content-type": second.contentType },
      payload: second.payload,
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<{ error: string }>().error).toContain(
      "alpha.jar already exists",
    );
    expect(
      (
        await listAddons(instancePaths(config.instancesRoot, serverId).addons)
      ).map((file) => file.name),
    ).toEqual(["alpha.jar", "beta.jar", "example-mod.jar"]);
    expect(store.getServer(serverId)?.revision).toBe(2);

    await app.close();
    store.db.close();
  });

  it("enforces the total size limit across all files", async () => {
    config.MAX_UPLOAD_BYTES = 5;
    const { app, store, serverId, sessionToken, csrfToken } = await fixture();
    const body = multipart([
      { name: "first.jar", contents: "123" },
      { name: "second.jar", contents: "456" },
    ]);
    const response = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/addons`,
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
        "content-type": body.contentType,
      },
      payload: body.payload,
    });
    expect(response.statusCode).toBe(413);
    expect(
      (
        await listAddons(instancePaths(config.instancesRoot, serverId).addons)
      ).map((file) => file.name),
    ).toEqual(["example-mod.jar"]);

    await app.close();
    store.db.close();
  });
});
