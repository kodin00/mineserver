import path from "node:path";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ServerConfigSchema,
  type ModrinthVersionSummary,
} from "@mineserver/shared";
import { hash } from "@node-rs/argon2";
import { listAddons } from "./addons.js";
import { buildApp } from "./app.js";
import { instancePaths } from "./compose.js";
import { config } from "./config.js";
import { Store } from "./db.js";
import type { ComposeManager } from "./docker.js";
import { JobRunner } from "./jobs.js";
import type { ModrinthApi } from "./modrinth.js";
import { sha256 } from "./utils.js";

const roots: string[] = [];
const originalInstancesRoot = config.instancesRoot;
const originalTempRoot = config.tempRoot;
const originalMaxUploadBytes = config.MAX_UPLOAD_BYTES;
const originalModrinthEnabled = config.MODRINTH_ENABLED;

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

async function fixture(
  docker: ComposeManager = {} as ComposeManager,
  modrinth: ModrinthApi = {} as ModrinthApi,
) {
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
  const jobs = new JobRunner(store);
  const app = (await buildApp({ store, docker, jobs, modrinth })).app;
  return { app, store, jobs, serverId, sessionToken, csrfToken };
}

describe("saved player lists", () => {
  it("returns whitelist and bans from disk even while the server is stopped", async () => {
    const { app, serverId, sessionToken } = await fixture();
    const data = instancePaths(config.instancesRoot, serverId).data;
    await mkdir(data, { recursive: true });
    await writeFile(
      path.join(data, "whitelist.json"),
      JSON.stringify([{ uuid: "alex-id", name: "Alex" }]),
    );
    await writeFile(
      path.join(data, "banned-players.json"),
      JSON.stringify([
        {
          uuid: "steve-id",
          name: "Steve",
          reason: "Griefing",
          expires: "forever",
        },
      ]),
    );
    const response = await app.inject({
      method: "GET",
      url: `/api/servers/${serverId}/players/lists`,
      headers: { cookie: `ms_session=${sessionToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      whitelist: [{ name: "Alex" }],
      banned: [{ name: "Steve", reason: "Griefing", expires: "forever" }],
    });
    await app.close();
  });
});

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

describe("server mutation coordination", () => {
  it("rejects synchronous and async routes while another change owns the server", async () => {
    const docker = {
      status: async () => ({ state: "stopped" as const, exists: true }),
      startExisting: async () => undefined,
    } as unknown as ComposeManager;
    const { app, store, jobs, serverId, sessionToken, csrfToken } =
      await fixture(docker);
    const headers = {
      cookie: `ms_session=${sessionToken}`,
      "x-csrf-token": csrfToken,
    };
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = jobs.mutations.runExclusive(
      serverId,
      "test-change",
      () => blocked,
    );

    const fileCreate = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/files`,
      headers,
      payload: { parentPath: "", name: "blocked.txt", type: "file" },
    });
    expect(fileCreate.statusCode).toBe(409);
    expect(fileCreate.json<{ error: string }>().error).toContain("test-change");

    const lifecycle = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/actions/start`,
      headers,
    });
    expect(lifecycle.statusCode).toBe(409);
    expect(store.listOperations(serverId)).toHaveLength(0);

    release();
    await first;
    const allowed = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/files`,
      headers,
      payload: { parentPath: "", name: "allowed.txt", type: "file" },
    });
    expect(allowed.statusCode).toBe(201);

    await app.close();
    store.db.close();
  });
});

describe("world routes", () => {
  it("returns active world information and requires a stopped server for import", async () => {
    const docker = {
      status: async () => ({ state: "running" as const, exists: true }),
    } as unknown as ComposeManager;
    const { app, store, serverId, sessionToken, csrfToken } =
      await fixture(docker);
    const world = instancePaths(config.instancesRoot, serverId).data;
    await mkdir(path.join(world, "world"), { recursive: true });
    await writeFile(path.join(world, "world", "level.dat"), "level");

    const info = await app.inject({
      method: "GET",
      url: `/api/servers/${serverId}/world`,
      headers: { cookie: `ms_session=${sessionToken}` },
    });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({
      levelName: "world",
      exists: true,
      serverState: "running",
      canImport: false,
    });

    const body = multipart([{ name: "world.zip", contents: "not-used" }]);
    const rejected = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/world/import`,
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
        "content-type": body.contentType,
      },
      payload: body.payload,
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json<{ error: string }>().error).toContain(
      "Stop the server",
    );

    await app.close();
    store.db.close();
  });

  it("blocks file mutations while a world mutation lease is active", async () => {
    const docker = {
      status: async () => ({ state: "stopped" as const, exists: true }),
    } as unknown as ComposeManager;
    const root = await mkdtemp(path.join(tmpdir(), "mineserver-world-lock-"));
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
    const sessionToken = "test-session";
    const csrfToken = "test-csrf";
    store.createSession(
      sha256(sessionToken),
      csrfToken,
      new Date(Date.now() + 60_000).toISOString(),
    );
    const jobs = new JobRunner(store);
    const app = (
      await buildApp({
        store,
        docker,
        jobs,
        modrinth: {} as ModrinthApi,
      })
    ).app;
    const lease = jobs.mutations.acquire(serverId, "world-import");
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/servers/${serverId}/files`,
        headers: {
          cookie: `ms_session=${sessionToken}`,
          "x-csrf-token": csrfToken,
        },
        payload: { parentPath: "", name: "racing.txt", type: "file" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: string }>().error).toContain(
        "world-import",
      );
    } finally {
      lease.release();
    }

    const created = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/files`,
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
      payload: { parentPath: "", name: "after.txt", type: "file" },
    });
    expect(created.statusCode).toBe(201);

    await app.close();
    store.db.close();
  });

  it("requires authentication and CSRF protection for world import", async () => {
    const docker = {
      status: async () => ({ state: "stopped" as const, exists: true }),
    } as unknown as ComposeManager;
    const { app, store, serverId, sessionToken } = await fixture(docker);
    const body = multipart([{ name: "world.zip", contents: "not a zip" }]);
    const unauthenticated = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/world/import`,
      headers: { "content-type": body.contentType },
      payload: body.payload,
    });
    expect(unauthenticated.statusCode).toBe(401);
    const noCsrf = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/world/import`,
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "content-type": body.contentType,
      },
      payload: body.payload,
    });
    expect(noCsrf.statusCode).toBe(403);

    await app.close();
    store.db.close();
  });
});

describe("player routes", () => {
  it("returns structured players and runs validated player actions", async () => {
    const commands: string[] = [];
    const docker = {
      console: async (_id: string, _paths: unknown, command: string) => {
        commands.push(command);
        return {
          stdout:
            command === "list"
              ? "There are 1 of a max of 20 players online: Steve"
              : "Kicked Steve: Please reconnect",
          stderr: "",
          code: 0,
        };
      },
    } as unknown as ComposeManager;
    const { app, store, serverId, sessionToken, csrfToken } =
      await fixture(docker);
    const cookie = `ms_session=${sessionToken}`;

    const listed = await app.inject({
      method: "GET",
      url: `/api/servers/${serverId}/players`,
      headers: { cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      online: 1,
      max: 20,
      players: [{ name: "Steve" }],
    });

    const action = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/players/actions`,
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      payload: {
        action: "kick",
        player: "Steve",
        reason: "Please reconnect",
      },
    });
    expect(action.statusCode).toBe(200);
    expect(action.json()).toMatchObject({
      ok: true,
      output: "Kicked Steve: Please reconnect",
    });
    expect(commands).toEqual(["list", "kick Steve Please reconnect", "list"]);

    await app.close();
    store.db.close();
  });

  it("rejects injection, enforces CSRF, and normalizes unavailable RCON", async () => {
    const docker = {
      console: async () => {
        throw new Error("RCON connection refused");
      },
    } as unknown as ComposeManager;
    const { app, store, serverId, sessionToken, csrfToken } =
      await fixture(docker);
    const cookie = `ms_session=${sessionToken}`;

    const noCsrf = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/players/actions`,
      headers: { cookie, "content-type": "application/json" },
      payload: { action: "op", player: "Steve" },
    });
    expect(noCsrf.statusCode).toBe(403);

    const injection = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/players/actions`,
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      payload: { action: "ban", player: "Steve", reason: "bad\nwhitelist off" },
    });
    expect(injection.statusCode).toBe(400);

    const unavailable = await app.inject({
      method: "GET",
      url: `/api/servers/${serverId}/players`,
      headers: { cookie },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json<{ error: string }>().error).toMatch(
      /unavailable.*not ready/i,
    );

    const whitelist = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/whitelist/actions`,
      headers: {
        cookie,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      payload: { action: "disable" },
    });
    expect(whitelist.statusCode).toBe(400);

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
  config.MODRINTH_ENABLED = originalModrinthEnabled;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("server file manager routes", () => {
  it("requires authentication and CSRF protection for file mutations", async () => {
    const { app, store, serverId, sessionToken } = await fixture();
    const unauthenticated = await app.inject({
      method: "GET",
      url: `/api/servers/${serverId}/files`,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const missingCsrf = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/files`,
      headers: { cookie: `ms_session=${sessionToken}` },
      payload: { parentPath: "", name: "notes.txt", type: "file" },
    });
    expect(missingCsrf.statusCode).toBe(403);

    await app.close();
    store.db.close();
  });

  it("creates, uploads, downloads, moves, and recursively deletes files", async () => {
    const { app, store, serverId, sessionToken, csrfToken } = await fixture();
    const headers = {
      cookie: `ms_session=${sessionToken}`,
      "x-csrf-token": csrfToken,
    };
    const data = instancePaths(config.instancesRoot, serverId).data;

    const created = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/files`,
      headers,
      payload: { parentPath: "", name: "imports", type: "directory" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      path: "imports",
      type: "directory",
    });

    const upload = multipart([
      { name: "alpha.bin", contents: "binary contents" },
      { name: "notes.txt", contents: "hello world" },
    ]);
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/files/upload?path=imports`,
      headers: { ...headers, "content-type": upload.contentType },
      payload: upload.payload,
    });
    expect(uploaded.statusCode).toBe(201);
    expect(
      uploaded
        .json<{ files: Array<{ path: string }> }>()
        .files.map((file) => file.path),
    ).toEqual(["imports/alpha.bin", "imports/notes.txt"]);

    const downloaded = await app.inject({
      method: "GET",
      url: `/api/servers/${serverId}/files/download?path=imports%2Falpha.bin`,
      headers: { cookie: `ms_session=${sessionToken}` },
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload.toString()).toBe("binary contents");
    expect(downloaded.headers["content-type"]).toBe("application/octet-stream");
    expect(downloaded.headers["content-disposition"]).toContain("alpha.bin");
    expect(downloaded.headers["x-content-type-options"]).toBe("nosniff");

    const moved = await app.inject({
      method: "PATCH",
      url: `/api/servers/${serverId}/files`,
      headers,
      payload: {
        path: "imports/notes.txt",
        destinationPath: "imports/readme.txt",
      },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ path: "imports/readme.txt" });
    expect(
      await readFile(path.join(data, "imports", "readme.txt"), "utf8"),
    ).toBe("hello world");

    const directory = await stat(path.join(data, "imports"));
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/servers/${serverId}/files?path=imports&expectedModifiedAt=${encodeURIComponent(directory.mtime.toISOString())}`,
      headers,
    });
    expect(deleted.statusCode).toBe(204);
    await expect(stat(path.join(data, "imports"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await app.close();
    store.db.close();
  });

  it("rejects collisions, root mutations, traversal, and symlink escapes", async () => {
    const { app, store, serverId, sessionToken, csrfToken } = await fixture();
    const headers = {
      cookie: `ms_session=${sessionToken}`,
      "x-csrf-token": csrfToken,
    };
    const data = instancePaths(config.instancesRoot, serverId).data;
    await mkdir(data, { recursive: true });
    await writeFile(path.join(data, "existing.txt"), "original");
    const outside = await mkdtemp(
      path.join(tmpdir(), "mineserver-files-route-outside-"),
    );
    roots.push(outside);
    await symlink(outside, path.join(data, "outside"), "dir");

    const collision = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/files`,
      headers,
      payload: { parentPath: "", name: "existing.txt", type: "file" },
    });
    expect(collision.statusCode).toBe(409);

    const rootDelete = await app.inject({
      method: "DELETE",
      url: `/api/servers/${serverId}/files?path=`,
      headers,
    });
    expect(rootDelete.statusCode).toBe(400);

    const traversal = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/files`,
      headers,
      payload: { parentPath: "../", name: "escape.txt", type: "file" },
    });
    expect(traversal.statusCode).toBe(400);

    const symlinkEscape = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/files`,
      headers,
      payload: { parentPath: "outside", name: "escape.txt", type: "file" },
    });
    expect(symlinkEscape.statusCode).toBe(400);
    await expect(stat(path.join(outside, "escape.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await app.close();
    store.db.close();
  });
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
      (await listAddons(instancePaths(config.instancesRoot, serverId).addons))
        .map((file) => file.name)
        .sort(),
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

describe("modrinth marketplace", () => {
  const jarBody = "fake jar bytes";
  const jarSha512 = createHash("sha512").update(jarBody).digest("hex");

  function versionFixture(overrides: Record<string, unknown> = {}) {
    return {
      id: "Nlt8gI9z",
      projectId: "P7dR8mSH",
      name: "Fabric API",
      versionNumber: "0.116.15+1.21.1",
      versionType: "release" as const,
      loaders: ["fabric"],
      gameVersions: ["1.21.1"],
      datePublished: "2026-01-01T00:00:00Z",
      downloads: 5,
      files: [
        {
          url: "https://cdn.modrinth.com/data/P7dR8mSH/versions/Nlt8gI9z/fabric-api.jar",
          filename: "fabric-api.jar",
          primary: true,
          size: jarBody.length,
          sha512: jarSha512,
          sha1: null,
        },
      ],
      dependencies: [],
      ...overrides,
    };
  }

  function fakeModrinth(overrides: Partial<ModrinthApi> = {}) {
    const searchCalls: unknown[] = [];
    const api = {
      search: async (input: unknown) => {
        searchCalls.push(input);
        return {
          hits: [],
          offset: 0,
          limit: 20,
          totalHits: 0,
          gameVersionApplied: false,
          appliedFacets: [],
        };
      },
      getProject: async () => ({
        id: "P7dR8mSH",
        slug: "fabric-api",
        title: "Fabric API",
        description: "",
        projectType: "mod",
        categories: [],
        loaders: ["fabric"],
        gameVersions: ["1.21.1"],
        iconUrl: null,
        license: null,
        sourceUrl: null,
        issuesUrl: null,
        downloads: 0,
        projectUrl: "https://modrinth.com/project/fabric-api",
      }),
      listVersions: async () => [versionFixture()],
      getVersion: async () => versionFixture(),
      tags: async () => ({ categories: [], loaders: [], gameVersions: [] }),
      downloadFile: async (
        _expected: unknown,
        temp: { path: string; stream: NodeJS.WritableStream },
      ) => {
        temp.stream.end(jarBody);
        await new Promise((resolve) => temp.stream.on("close", resolve));
      },
      invalidate: () => undefined,
      checkToken: async () => null,
      ...overrides,
    } as unknown as ModrinthApi;
    return { api, searchCalls };
  }

  function dependencyVersion(
    id: string,
    required: string[] = [],
  ): ModrinthVersionSummary {
    const base = versionFixture();
    return {
      ...base,
      id,
      projectId: id,
      name: id,
      files: [{ ...base.files[0]!, filename: `${id}.jar` }],
      dependencies: required.map((versionId) => ({
        projectId: versionId,
        versionId,
        title: versionId,
        dependencyType: "required" as const,
      })),
    };
  }

  it("automatically installs transitive requirements, deduplicates a cycle, and ignores optional dependencies", async () => {
    const root = dependencyVersion("ROOT0001", ["DEPA0001", "DEPB0001"]);
    root.dependencies.push({
      projectId: "OPTIONAL",
      versionId: "OPTIONAL",
      title: "Optional",
      dependencyType: "optional",
    });
    const versions: Record<string, ModrinthVersionSummary> = {
      ROOT0001: root,
      DEPA0001: dependencyVersion("DEPA0001", ["SHARED01"]),
      DEPB0001: dependencyVersion("DEPB0001", ["SHARED01"]),
      SHARED01: dependencyVersion("SHARED01", ["ROOT0001"]),
    };
    const { api } = fakeModrinth({ getVersion: async (id) => versions[id]! });
    const { app, store, serverId, sessionToken, csrfToken } = await fixture(
      undefined,
      api,
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/modrinth/install`,
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
      payload: { versionId: "ROOT0001", projectType: "mod" },
    });
    expect(response.statusCode).toBe(202);
    await expect
      .poll(
        () =>
          store
            .listOperations(serverId)
            .find((op) => op.id === response.json().id)?.status,
      )
      .toBe("succeeded");
    expect(
      store
        .listAddonSources(serverId)
        .map((source) => source.project_id)
        .sort(),
    ).toEqual(Object.keys(versions).sort());
    await app.close();
  });

  it("downloads selected mods concurrently and installs their shared dependency only once", async () => {
    const versions: Record<string, ModrinthVersionSummary> = {
      ROOT0001: dependencyVersion("ROOT0001", ["SHARED01"]),
      ROOT0002: dependencyVersion("ROOT0002", ["SHARED01"]),
      SHARED01: dependencyVersion("SHARED01"),
    };
    const { api } = fakeModrinth({ getVersion: async (id) => versions[id]! });
    let active = 0,
      maximum = 0;
    const download = api.downloadFile;
    api.downloadFile = async (expected, temp) => {
      active++;
      maximum = Math.max(maximum, active);
      await download(expected, temp);
      active--;
    };
    const { app, store, serverId, sessionToken, csrfToken } = await fixture(
      undefined,
      api,
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/modrinth/install-batch`,
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
      payload: {
        items: [
          { versionId: "ROOT0001", projectType: "mod" },
          { versionId: "ROOT0002", projectType: "mod" },
        ],
      },
    });
    expect(response.statusCode).toBe(202);
    await expect
      .poll(
        () =>
          store
            .listOperations(serverId)
            .find((op) => op.id === response.json().id)?.status,
      )
      .toBe("succeeded");
    expect(store.listAddonSources(serverId)).toHaveLength(3);
    expect(maximum).toBeGreaterThan(1);
    expect(store.getServer(serverId)?.revision).toBe(2);
    await app.close();
  });

  it("rolls back the entire selection when a selected filename collides", async () => {
    const versions: Record<string, ModrinthVersionSummary> = {
      ROOT0001: dependencyVersion("ROOT0001"),
      ROOT0002: dependencyVersion("ROOT0002"),
    };
    versions.ROOT0002!.files[0]!.filename = "example-mod.jar";
    const { api } = fakeModrinth({ getVersion: async (id) => versions[id]! });
    const { app, store, serverId, sessionToken, csrfToken } = await fixture(
      undefined,
      api,
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/modrinth/install-batch`,
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
      payload: {
        items: [
          { versionId: "ROOT0001", projectType: "mod" },
          { versionId: "ROOT0002", projectType: "mod" },
        ],
      },
    });
    // A preexisting primary must not be silently skipped as if it were a verified dependency.
    expect(response.statusCode).toBe(202);
    await expect
      .poll(
        () =>
          store
            .listOperations(serverId)
            .find((op) => op.id === response.json().id)?.status,
      )
      .toBe("failed");
    expect(
      (
        await listAddons(instancePaths(config.instancesRoot, serverId).addons)
      ).map((file) => file.name),
    ).toEqual(["example-mod.jar"]);
    expect(store.listAddonSources(serverId)).toHaveLength(0);
    await app.close();
  });

  it("rejects conflicting versions across a batch before downloading", async () => {
    const dependency = dependencyVersion("DEP00001");
    const other = { ...dependencyVersion("DEP00002"), projectId: "DEP00001" };
    const root = dependencyVersion("ROOT0002");
    root.dependencies.push({
      projectId: "DEP00001",
      versionId: "DEP00002",
      title: null,
      dependencyType: "required",
    });
    const versions: Record<string, ModrinthVersionSummary> = {
      ROOT0001: dependencyVersion("ROOT0001", ["DEP00001"]),
      ROOT0002: root,
      DEP00001: dependency,
      DEP00002: other,
    };
    const { api } = fakeModrinth({
      getVersion: async (id) => versions[id]!,
      downloadFile: vi.fn(),
    });
    const { app, store, serverId, sessionToken, csrfToken } = await fixture(
      undefined,
      api,
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/modrinth/install-batch`,
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
      payload: {
        items: [
          { versionId: "ROOT0001", projectType: "mod" },
          { versionId: "ROOT0002", projectType: "mod" },
        ],
      },
    });
    expect(response.statusCode).toBe(202);
    await expect
      .poll(
        () =>
          store
            .listOperations(serverId)
            .find((op) => op.id === response.json().id)?.status,
      )
      .toBe("failed");
    expect(api.downloadFile).not.toHaveBeenCalled();
    expect(store.listAddonSources(serverId)).toHaveLength(0);
    await app.close();
  });

  it("cleans temporary files when a dependency download fails", async () => {
    const versions: Record<string, ModrinthVersionSummary> = {
      ROOT0001: dependencyVersion("ROOT0001", ["DEP00001"]),
      DEP00001: dependencyVersion("DEP00001"),
    };
    const { api } = fakeModrinth({ getVersion: async (id) => versions[id]! });
    const download = api.downloadFile;
    api.downloadFile = async (expected, temp) => {
      if (expected.filename === "DEP00001.jar")
        throw new Error("Download failed");
      await download(expected, temp);
    };
    const { app, store, serverId, sessionToken, csrfToken } = await fixture(
      undefined,
      api,
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/modrinth/install-batch`,
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
      payload: { items: [{ versionId: "ROOT0001", projectType: "mod" }] },
    });
    await expect
      .poll(
        () =>
          store
            .listOperations(serverId)
            .find((op) => op.id === response.json().id)?.status,
      )
      .toBe("failed");
    expect(store.listAddonSources(serverId)).toHaveLength(0);
    expect(await readdir(config.tempRoot)).toEqual([]);
    await app.close();
  });

  it("installs new required dependencies during updates and returns downloaded project images", async () => {
    const old = { ...dependencyVersion("OLD00001"), projectId: "PROJECT1" };
    const next = {
      ...dependencyVersion("NEW00001", ["DEP00001"]),
      projectId: "PROJECT1",
    };
    const versions: Record<string, ModrinthVersionSummary> = {
      OLD00001: old,
      NEW00001: next,
      DEP00001: dependencyVersion("DEP00001"),
    };
    const { api } = fakeModrinth({ getVersion: async (id) => versions[id]! });
    const project = api.getProject;
    api.getProject = async (id) => ({
      ...(await project(id)),
      iconUrl: "https://cdn.modrinth.com/project-icon.png",
    });
    const { app, store, serverId, sessionToken, csrfToken } = await fixture(
      undefined,
      api,
    );
    const headers = {
      cookie: `ms_session=${sessionToken}`,
      "x-csrf-token": csrfToken,
    };
    const install = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/modrinth/install`,
      headers,
      payload: { versionId: old.id, projectType: "mod" },
    });
    await expect
      .poll(
        () =>
          store
            .listOperations(serverId)
            .find((op) => op.id === install.json().id)?.status,
      )
      .toBe("succeeded");
    const update = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/modrinth/update`,
      headers,
      payload: {
        projectId: "PROJECT1",
        currentVersionId: old.id,
        versionId: next.id,
        projectType: "mod",
      },
    });
    expect(update.statusCode).toBe(202);
    await expect
      .poll(
        () =>
          store
            .listOperations(serverId)
            .find((op) => op.id === update.json().id)?.status,
      )
      .toBe("succeeded");
    expect(store.listAddonSources(serverId)).toHaveLength(2);
    expect(
      (await listAddons(instancePaths(config.instancesRoot, serverId).addons))
        .map((file) => file.name)
        .sort(),
    ).toEqual(["DEP00001.jar", "NEW00001.jar", "example-mod.jar"]);
    const downloaded = await app.inject({
      method: "GET",
      url: `/api/servers/${serverId}/addons`,
      headers,
    });
    expect(downloaded.json().files).toContainEqual(
      expect.objectContaining({
        name: "NEW00001.jar",
        projectTitle: "Fabric API",
        iconUrl: "https://cdn.modrinth.com/project-icon.png",
        addedAt: expect.any(String),
      }),
    );
    await app.close();
  });

  it("protects batch installs with CSRF and rejects empty selections", async () => {
    const { api } = fakeModrinth();
    const { app, serverId, sessionToken, csrfToken } = await fixture(
      undefined,
      api,
    );
    const url = `/api/servers/${serverId}/modrinth/install-batch`;
    const noCsrf = await app.inject({
      method: "POST",
      url,
      headers: { cookie: `ms_session=${sessionToken}` },
      payload: { items: [{ versionId: "Nlt8gI9z", projectType: "mod" }] },
    });
    expect(noCsrf.statusCode).toBe(403);
    const empty = await app.inject({
      method: "POST",
      url,
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
      payload: { items: [] },
    });
    expect(empty.statusCode).toBe(400);
    await app.close();
  });

  it("derives facets server-side and ignores a client-supplied facets param", async () => {
    const { api, searchCalls } = fakeModrinth();
    const { app, sessionToken } = await fixture({} as ComposeManager, api);
    const response = await app.inject({
      method: "GET",
      url: "/api/modrinth/search?q=sodium&serverType=FABRIC&gameVersion=1.21.1&projectType=mod&limit=500&facets=[[%22project_type:modpack%22]]",
      headers: { cookie: `ms_session=${sessionToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(searchCalls).toHaveLength(1);
    const call = searchCalls[0] as Record<string, unknown>;
    expect(call).not.toHaveProperty("facets");
    // The 500 the client asked for is clamped to the documented maximum.
    expect(call.limit).toBe(50);
    await app.close();
  });

  it("rejects a project type the server type cannot load", async () => {
    const { api } = fakeModrinth();
    const { app, sessionToken } = await fixture({} as ComposeManager, api);
    const response = await app.inject({
      method: "GET",
      url: "/api/modrinth/search?serverType=VANILLA&projectType=mod",
      headers: { cookie: `ms_session=${sessionToken}` },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a traversal attempt in a project id", async () => {
    const { api } = fakeModrinth();
    const { app, sessionToken } = await fixture({} as ComposeManager, api);
    const response = await app.inject({
      method: "GET",
      url: "/api/modrinth/projects/..%2F..%2Fetc%2Fpasswd/versions",
      headers: { cookie: `ms_session=${sessionToken}` },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("installs a jar, records its provenance and marks the server pending", async () => {
    const { api } = fakeModrinth();
    const { app, store, serverId, sessionToken, csrfToken } = await fixture(
      {} as ComposeManager,
      api,
    );
    const before = store.getServer(serverId)!.revision;
    const response = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/modrinth/install`,
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
      payload: { versionId: "Nlt8gI9z", projectType: "mod" },
    });
    expect(response.statusCode).toBe(202);
    const operation = response.json();
    await expect
      .poll(
        () =>
          store.listOperations(serverId).find((op) => op.id === operation.id)
            ?.status,
      )
      .toBe("succeeded");

    const addons = instancePaths(config.instancesRoot, serverId).addons;
    const files = await listAddons(addons);
    expect(files.map((file) => file.name)).toContain("fabric-api.jar");
    expect((await stat(path.join(addons, "fabric-api.jar"))).mode & 0o777).toBe(
      0o644,
    );
    expect(store.getServer(serverId)!.revision).toBe(before + 1);

    const sources = store.listAddonSources(serverId);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      filename: "fabric-api.jar",
      provider: "modrinth",
      project_id: "P7dR8mSH",
      version_id: "Nlt8gI9z",
      sha512: jarSha512,
    });
    await app.close();
  });

  it("fails the operation and installs nothing when the download is bad", async () => {
    const { api } = fakeModrinth({
      downloadFile: async () => {
        throw Object.assign(
          new Error("Downloaded file failed its integrity check"),
          {
            statusCode: 502,
          },
        );
      },
    });
    const { app, store, serverId, sessionToken, csrfToken } = await fixture(
      {} as ComposeManager,
      api,
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/modrinth/install`,
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
      payload: { versionId: "Nlt8gI9z", projectType: "mod" },
    });
    expect(response.statusCode).toBe(202);
    const operation = response.json();
    await expect
      .poll(
        () =>
          store.listOperations(serverId).find((op) => op.id === operation.id)
            ?.status,
      )
      .toBe("failed");
    const files = await listAddons(
      instancePaths(config.instancesRoot, serverId).addons,
    );
    expect(files.map((file) => file.name)).not.toContain("fabric-api.jar");
    expect(store.listAddonSources(serverId)).toHaveLength(0);
    await app.close();
  });

  it("refuses a shader install up front rather than failing the job", async () => {
    const { api } = fakeModrinth();
    const { app, serverId, sessionToken, csrfToken } = await fixture(
      {} as ComposeManager,
      api,
    );
    for (const projectType of ["shader", "resourcepack"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/servers/${serverId}/modrinth/install`,
        headers: {
          cookie: `ms_session=${sessionToken}`,
          "x-csrf-token": csrfToken,
        },
        payload: { versionId: "Nlt8gI9z", projectType },
      });
      expect(response.statusCode).toBe(400);
    }
    await app.close();
  });

  it("refuses to preview a shader and says why", async () => {
    const { api } = fakeModrinth();
    const { app, serverId, sessionToken, csrfToken } = await fixture(
      {} as ComposeManager,
      api,
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/modrinth/preview`,
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
      payload: { versionId: "Nlt8gI9z", projectType: "shader" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/own Minecraft client/);
    await app.close();
  });

  it("refuses a mod install on a vanilla server", async () => {
    const { api } = fakeModrinth();
    const { app, store, serverId, sessionToken, csrfToken } = await fixture(
      {} as ComposeManager,
      api,
    );
    store.updateServer(
      serverId,
      ServerConfigSchema.parse({ name: "Test server", type: "VANILLA" }),
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/modrinth/preview`,
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
      payload: { versionId: "Nlt8gI9z", projectType: "mod" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/cannot load/);
    await app.close();
  });

  it("requires a CSRF token to install", async () => {
    const { api } = fakeModrinth();
    const { app, serverId, sessionToken } = await fixture(
      {} as ComposeManager,
      api,
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/modrinth/install`,
      headers: { cookie: `ms_session=${sessionToken}` },
      payload: { versionId: "Nlt8gI9z", projectType: "mod" },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("returns 503 everywhere when the marketplace is disabled", async () => {
    const { api } = fakeModrinth();
    const { app, serverId, sessionToken, csrfToken } = await fixture(
      {} as ComposeManager,
      api,
    );
    config.MODRINTH_ENABLED = false;
    const search = await app.inject({
      method: "GET",
      url: "/api/modrinth/search?serverType=FABRIC&projectType=mod",
      headers: { cookie: `ms_session=${sessionToken}` },
    });
    expect(search.statusCode).toBe(503);
    const install = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/modrinth/install`,
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
      payload: { versionId: "Nlt8gI9z", projectType: "mod" },
    });
    expect(install.statusCode).toBe(503);
    // The routes still exist, so a client can tell "disabled" from "outdated".
    expect(install.json().error).toMatch(/disabled/);
    await app.close();
  });

  it("lists installed datapacks for the resolved world", async () => {
    const { api } = fakeModrinth();
    const { app, store, serverId, sessionToken } = await fixture(
      {} as ComposeManager,
      api,
    );
    store.updateServer(
      serverId,
      ServerConfigSchema.parse({
        name: "Test server",
        type: "PAPER",
        customProperties: { "level-name": "survival" },
      }),
    );
    const empty = await app.inject({
      method: "GET",
      url: `/api/servers/${serverId}/datapacks`,
      headers: { cookie: `ms_session=${sessionToken}` },
    });
    expect(empty.json()).toEqual({ levelName: "survival", files: [] });

    const data = instancePaths(config.instancesRoot, serverId).data;
    await mkdir(path.join(data, "survival", "datapacks"), { recursive: true });
    await writeFile(
      path.join(data, "survival", "datapacks", "pack.zip"),
      "zip bytes",
    );
    const listed = await app.inject({
      method: "GET",
      url: `/api/servers/${serverId}/datapacks`,
      headers: { cookie: `ms_session=${sessionToken}` },
    });
    expect(
      listed.json().files.map((file: { name: string }) => file.name),
    ).toEqual(["pack.zip"]);
    await app.close();
  });

  it("stores marketplace settings without ever echoing the token", async () => {
    const { api } = fakeModrinth();
    const { app, store, sessionToken, csrfToken } = await fixture(
      {} as ComposeManager,
      api,
    );
    const initial = await app.inject({
      method: "GET",
      url: "/api/settings/marketplace",
      headers: { cookie: `ms_session=${sessionToken}` },
    });
    expect(initial.json()).toMatchObject({ hasToken: false, contact: "" });

    const saved = await app.inject({
      method: "PUT",
      url: "/api/settings/marketplace",
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
      payload: {
        enabled: true,
        contact: "ops@example.test",
        token: "mrp_super_secret_value",
      },
    });
    expect(saved.statusCode).toBe(200);
    const body = saved.json();
    expect(body.hasToken).toBe(true);
    expect(body.userAgent).toContain("ops@example.test");
    // The secret must not come back on any field, at any depth.
    expect(saved.payload).not.toContain("mrp_super_secret_value");
    expect(body).not.toHaveProperty("token");
    expect(typeof body.tokenUpdatedAt).toBe("string");

    // Omitting the token leaves the stored one alone.
    const again = await app.inject({
      method: "PUT",
      url: "/api/settings/marketplace",
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
      payload: { enabled: true, contact: "ops@example.test" },
    });
    expect(again.json().hasToken).toBe(true);

    // An explicit null clears it.
    const cleared = await app.inject({
      method: "PUT",
      url: "/api/settings/marketplace",
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
      payload: { enabled: true, contact: "", token: null },
    });
    expect(cleared.json()).toMatchObject({ hasToken: false, contact: "" });
    expect(store.getPanelSettings(true).modrinth_token).toBeNull();
    await app.close();
  });

  it("reports whether a freshly entered token authenticates", async () => {
    for (const [valid, expected] of [
      [true, "valid"],
      [false, "invalid"],
    ] as const) {
      const { api } = fakeModrinth({ checkToken: async () => valid });
      const { app, sessionToken, csrfToken } = await fixture(
        {} as ComposeManager,
        api,
      );
      const response = await app.inject({
        method: "PUT",
        url: "/api/settings/marketplace",
        headers: {
          cookie: `ms_session=${sessionToken}`,
          "x-csrf-token": csrfToken,
        },
        payload: { enabled: true, contact: "", token: "mrp_probe" },
      });
      expect(response.json().tokenStatus).toBe(expected);
      await app.close();
    }
  });

  it("reports an unreachable marketplace instead of blaming the token", async () => {
    const { api } = fakeModrinth({
      checkToken: async () => {
        throw Object.assign(new Error("upstream down"), { statusCode: 502 });
      },
    });
    const { app, sessionToken, csrfToken } = await fixture(
      {} as ComposeManager,
      api,
    );
    const response = await app.inject({
      method: "PUT",
      url: "/api/settings/marketplace",
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
      payload: { enabled: true, contact: "", token: "mrp_probe" },
    });
    // Saving must still succeed; only the check failed.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      hasToken: true,
      tokenStatus: "unreachable",
    });
    await app.close();
  });

  it("disables the marketplace from settings rather than the environment", async () => {
    const { api } = fakeModrinth();
    const { app, serverId, sessionToken, csrfToken } = await fixture(
      {} as ComposeManager,
      api,
    );
    await app.inject({
      method: "PUT",
      url: "/api/settings/marketplace",
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
      payload: { enabled: false, contact: "" },
    });
    const search = await app.inject({
      method: "GET",
      url: "/api/modrinth/search?serverType=FABRIC&projectType=mod",
      headers: { cookie: `ms_session=${sessionToken}` },
    });
    expect(search.statusCode).toBe(503);
    const meta = await app.inject({
      method: "GET",
      url: "/api/metadata",
      headers: { cookie: `ms_session=${sessionToken}` },
    });
    expect(meta.json().modrinthEnabled).toBe(false);
    const install = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/modrinth/install`,
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
      payload: { versionId: "Nlt8gI9z", projectType: "mod" },
    });
    expect(install.statusCode).toBe(503);
    await app.close();
  });

  it("requires a CSRF token to change marketplace settings", async () => {
    const { api } = fakeModrinth();
    const { app, sessionToken } = await fixture({} as ComposeManager, api);
    const response = await app.inject({
      method: "PUT",
      url: "/api/settings/marketplace",
      headers: { cookie: `ms_session=${sessionToken}` },
      payload: { enabled: false, contact: "" },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("keeps old releases in metadata behind many snapshots", async () => {
    const manifest = {
      versions: [
        ...Array.from({ length: 120 }, (_, index) => ({
          id: `snap-${index}`,
          type: "snapshot",
        })),
        { id: "1.21.1", type: "release" },
        { id: "1.20.1", type: "release" },
        { id: "b1.7.3", type: "old_beta" },
      ],
    };
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0]) =>
      String(input).includes("version_manifest_v2.json")
        ? Promise.resolve(Response.json(manifest))
        : Promise.resolve(new Response("{}", { status: 503 })),
    );
    const { api } = fakeModrinth();
    const { app, sessionToken } = await fixture({} as ComposeManager, api);
    const response = await app.inject({
      method: "GET",
      url: "/api/metadata",
      headers: { cookie: `ms_session=${sessionToken}` },
    });
    vi.stubGlobal("fetch", realFetch);
    const ids = (response.json().versions as Array<{ id: string }>).map(
      (version) => version.id,
    );
    expect(ids).toHaveLength(52);
    expect(ids.slice(0, 2)).toEqual(["snap-0", "snap-1"]);
    expect(ids.slice(-2)).toEqual(["1.21.1", "1.20.1"]);
    await app.close();
  });

  it("reports the marketplace flag through metadata", async () => {
    const { api } = fakeModrinth();
    const { app, sessionToken } = await fixture({} as ComposeManager, api);
    config.MODRINTH_ENABLED = false;
    const response = await app.inject({
      method: "GET",
      url: "/api/metadata",
      headers: { cookie: `ms_session=${sessionToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().modrinthEnabled).toBe(false);
    await app.close();
  });
});

describe("player access and mod requests", () => {
  it("enforces a player allowlist and hides server secrets", async () => {
    const docker = {
      status: async () => ({ state: "stopped", exists: true }),
    } as unknown as ComposeManager;
    const { app, store, serverId } = await fixture(docker);
    const row = store.getServer(serverId)!;
    store.updateServer(
      serverId,
      ServerConfigSchema.parse({
        ...JSON.parse(row.config_json),
        publicAddress: "play.example.org",
        advancedEnv: { SECRET: "hidden" },
        seed: "secret-seed",
      }),
    );
    store.createSession(
      sha256("player-token"),
      "csrf",
      new Date(Date.now() + 60000).toISOString(),
      "player",
    );
    const headers = {
      cookie: "ms_session=player-token",
      "x-csrf-token": "csrf",
    };
    const summary = await app.inject({
      method: "GET",
      url: `/api/servers/${serverId}`,
      headers,
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().config.publicAddress).toBe("play.example.org");
    expect(summary.body).not.toContain("hidden");
    expect(summary.body).not.toContain("secret-seed");
    for (const [method, url] of [
      ["GET", `/api/servers/${serverId}/files`],
      ["GET", "/api/settings/marketplace"],
      ["GET", "/ws/console"],
      ["POST", `/api/servers/${serverId}/actions/restart`],
      ["PUT", `/api/servers/${serverId}`],
      ["POST", "/api/auth/password"],
      ["POST", `/api/servers/${serverId}/mod-requests/request-1/approve`],
      ["POST", `/api/servers/${serverId}/mod-requests/request-1/decline`],
      ["PUT", "/api/auth/player-access"],
    ] as const) {
      expect((await app.inject({ method, url, headers })).statusCode).toBe(403);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/servers/${serverId}/mod-requests`,
          headers: { cookie: headers.cookie },
          payload: { items: [] },
        })
      ).statusCode,
    ).toBe(403);
    await app.close();
    store.db.close();
  });

  it("provisions player login and revokes sessions on password changes and disable", async () => {
    const { app, store, sessionToken, csrfToken } = await fixture();
    store.createAdmin(await hash("admin password 123"));
    const headers = {
      cookie: `ms_session=${sessionToken}`,
      "x-csrf-token": csrfToken,
    };
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/auth/player-access",
          headers,
          payload: { enabled: true, password: "player password 123" },
        })
      ).statusCode,
    ).toBe(200);
    const bad = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { role: "admin", password: "player password 123" },
    });
    expect(bad.statusCode).toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { role: "player", password: "player password 123" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().role).toBe("player");
    const playerCookie = login.cookies.find(
      (cookie) => cookie.name === "ms_session",
    )!;
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/me",
          headers: { cookie: `ms_session=${playerCookie.value}` },
        })
      ).statusCode,
    ).toBe(200);
    await app.inject({
      method: "PUT",
      url: "/api/auth/player-access",
      headers,
      payload: { enabled: true, password: "new player password" },
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/me",
          headers: { cookie: `ms_session=${playerCookie.value}` },
        })
      ).statusCode,
    ).toBe(401);
    const login2 = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { role: "player", password: "new player password" },
    });
    const cookie2 = login2.cookies.find(
      (cookie) => cookie.name === "ms_session",
    )!;
    await app.inject({
      method: "PUT",
      url: "/api/auth/player-access",
      headers,
      payload: { enabled: false },
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/auth/me",
          headers: { cookie: `ms_session=${cookie2.value}` },
        })
      ).statusCode,
    ).toBe(401);
    await app.close();
    store.db.close();
  });

  it("does not issue a player session if access is disabled during password verification", async () => {
    const { app, store } = await fixture();
    const passwordHash = await hash("player password 123");
    store.setPlayerAccess(true, passwordHash);
    const getAccess = store.getPlayerAccess.bind(store);
    const access = vi
      .spyOn(store, "getPlayerAccess")
      .mockImplementationOnce(() => {
        const value = getAccess();
        queueMicrotask(() => store.setPlayerAccess(false, passwordHash));
        return value;
      });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { role: "player", password: "player password 123" },
      });
      expect(response.statusCode).toBe(401);
      expect(response.cookies).toHaveLength(0);
    } finally {
      access.mockRestore();
      await app.close();
      store.db.close();
    }
  });

  it("serializes decisions and reports failed installations", async () => {
    let fail = false;
    const contents = "fake jar";
    const api = {
      getVersion: async (id: string) => {
        if (fail) throw new Error("Network unavailable");
        return {
          id,
          projectId: id,
          versionNumber: "1.0",
          loaders: ["fabric"],
          gameVersions: ["1.21.1"],
          dependencies: [],
          files: [
            {
              filename: `${id}.jar`,
              primary: true,
              size: contents.length,
              sha512: createHash("sha512").update(contents).digest("hex"),
              sha1: null,
              url: `https://cdn.modrinth.com/${id}.jar`,
            },
          ],
        };
      },
      getProject: async () => ({ title: "Test mod" }),
      listVersions: async ({ idOrSlug }: { idOrSlug: string }) => [
        { id: idOrSlug, projectId: idOrSlug },
      ],
      downloadFile: async (
        _file: unknown,
        temp: { stream: NodeJS.WritableStream },
      ) => {
        temp.stream.end(contents);
        await new Promise((resolve) => temp.stream.on("close", resolve));
      },
    } as unknown as ModrinthApi;
    const { app, store, serverId, sessionToken, csrfToken } = await fixture(
      undefined,
      api,
    );
    store.updatePanelSettings({ enabled: true, contact: "" });
    const headers = {
      cookie: `ms_session=${sessionToken}`,
      "x-csrf-token": csrfToken,
    };
    const create = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/mod-requests`,
      headers,
      payload: {
        items: [
          { projectId: "abcdefgh", versionId: "abcdefgh", projectType: "mod" },
        ],
      },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;
    expect(create.json().items[0].title).toBe("Test mod");
    fail = true;
    const approve = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/mod-requests/${id}/approve`,
      headers,
    });
    expect(approve.statusCode).toBe(202);
    await expect
      .poll(() => store.getModRequest(serverId, id)?.status)
      .toBe("failed");
    expect(store.getModRequest(serverId, id)?.error).toContain(
      "0 of 1 requested projects installed",
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/servers/${serverId}/mod-requests/${id}/decline`,
          headers,
        })
      ).statusCode,
    ).toBe(409);
    fail = false;
    const invalid = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/mod-requests`,
      headers,
      payload: {
        items: [
          { projectId: "abcdefgh", versionId: "invalid1", projectType: "mod" },
        ],
      },
    });
    expect(invalid.statusCode).toBe(400);
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/mod-requests`,
      headers,
      payload: {
        items: [
          { projectId: "abcdefgh", versionId: "abcdefgh", projectType: "mod" },
          { projectId: "abcdefgh", versionId: "abcdefgh", projectType: "mod" },
        ],
      },
    });
    expect(duplicate.statusCode).toBe(400);
    const success = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/mod-requests`,
      headers,
      payload: {
        items: [
          { projectId: "abcdefgh", versionId: "abcdefgh", projectType: "mod" },
          { projectId: "ijklmnop", versionId: "ijklmnop", projectType: "mod" },
        ],
      },
    });
    expect(success.statusCode).toBe(201);
    const successId = success.json().id;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/servers/${serverId}/mod-requests/${successId}/approve`,
          headers,
        })
      ).statusCode,
    ).toBe(202);
    await expect
      .poll(() => store.getModRequest(serverId, successId)?.status)
      .toBe("approved");
    expect(
      await readFile(
        path.join(
          instancePaths(config.instancesRoot, serverId).addons,
          "abcdefgh.jar",
        ),
        "utf8",
      ),
    ).toBe(contents);
    expect(
      await readFile(
        path.join(
          instancePaths(config.instancesRoot, serverId).addons,
          "ijklmnop.jar",
        ),
        "utf8",
      ),
    ).toBe(contents);
    const pending = store.createModRequest(serverId, [
      { projectId: "abcdefgh", versionId: "abcdefgh", projectType: "mod" },
    ]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/servers/${serverId}/mod-requests/${pending.id}/decline`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(store.getModRequest(serverId, pending.id)?.status).toBe("declined");
    await app.close();
    store.db.close();
  });
});

describe("route input handling", () => {
  it("rejects an unknown server action without recording an operation", async () => {
    const { app, store, serverId, sessionToken, csrfToken } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/actions/explode`,
      headers: {
        cookie: `ms_session=${sessionToken}`,
        "x-csrf-token": csrfToken,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(store.listOperations(serverId)).toHaveLength(0);
    await app.close();
    store.db.close();
  });

  it("decodes add-on filenames once so a literal percent sign works", async () => {
    const { app, store, serverId, sessionToken, csrfToken } = await fixture();
    const directory = instancePaths(config.instancesRoot, serverId).addons;
    await writeFile(path.join(directory, "50%25off.jar"), "jar");
    const headers = {
      cookie: `ms_session=${sessionToken}`,
      "x-csrf-token": csrfToken,
    };
    const url = `/api/servers/${serverId}/addons/${encodeURIComponent("50%25off.jar")}`;
    const download = await app.inject({
      method: "GET",
      url: `${url}/download`,
      headers,
    });
    expect(download.statusCode).toBe(200);
    const removed = await app.inject({ method: "DELETE", url, headers });
    expect(removed.statusCode).toBe(200);
    await expect(
      stat(path.join(directory, "50%25off.jar")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await app.close();
    store.db.close();
  });
});
