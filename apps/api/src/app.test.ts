import path from "node:path";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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
