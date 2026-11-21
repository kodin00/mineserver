import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerConfigSchema } from "@mineserver/shared";
import * as argon2 from "@node-rs/argon2";
import { buildApp, isTrustedProxyAddress } from "./app.js";
import { instancePaths } from "./compose.js";
import { config } from "./config.js";
import { Store } from "./db.js";
import { JobRunner } from "./jobs.js";
import type { ModrinthApi } from "./modrinth.js";
import { MAX_PENDING_MOD_REQUESTS_PER_SERVER } from "./routes/marketplace.js";
import { sha256 } from "./utils.js";

vi.mock("@node-rs/argon2", async (importOriginal) => {
  const original = await importOriginal<typeof import("@node-rs/argon2")>();
  return { ...original, verify: vi.fn(original.verify) };
});

const roots: string[] = [];
const originalInstancesRoot = config.instancesRoot;
const originalTempRoot = config.tempRoot;
const originalModrinthEnabled = config.MODRINTH_ENABLED;

afterEach(async () => {
  config.instancesRoot = originalInstancesRoot;
  config.tempRoot = originalTempRoot;
  config.MODRINTH_ENABLED = originalModrinthEnabled;
  vi.mocked(argon2.verify).mockClear();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const modrinth = {
  getVersion: async (id: string) => ({
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
        size: 8,
        sha512: createHash("sha512").update("fake jar").digest("hex"),
        sha1: null,
        url: `https://cdn.modrinth.com/${id}.jar`,
      },
    ],
  }),
  getProject: async () => ({ title: "Test mod" }),
  listVersions: async ({ idOrSlug }: { idOrSlug: string }) => [
    { id: idOrSlug, projectId: idOrSlug },
  ],
} as unknown as ModrinthApi;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "mineserver-hardening-"));
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
  await mkdir(instancePaths(config.instancesRoot, serverId).data, {
    recursive: true,
  });
  store.createSession(
    sha256("admin-token"),
    "csrf",
    new Date(Date.now() + 60_000).toISOString(),
  );
  store.createSession(
    sha256("player-token"),
    "csrf",
    new Date(Date.now() + 60_000).toISOString(),
    "player",
  );
  const jobs = new JobRunner(store);
  const { app } = await buildApp({
    store,
    docker: {} as never,
    jobs,
    modrinth,
  });
  const admin = { cookie: "ms_session=admin-token", "x-csrf-token": "csrf" };
  const player = { cookie: "ms_session=player-token", "x-csrf-token": "csrf" };
  return { app, store, serverId, admin, player, root };
}

describe("error handler", () => {
  it("returns a generic 500 for unclassified errors without leaking details", async () => {
    const { app, store, admin } = await fixture();
    app.get("/api/boom", async () => {
      throw new Error(
        "SQLITE_ERROR: no such table x at /srv/data/panel.sqlite",
      );
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/boom",
      headers: admin,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Internal server error" });
    expect(response.body).not.toContain("/srv/data");
    await app.close();
    store.db.close();
  });

  it("logs unclassified errors server-side", async () => {
    const { app, store, admin } = await fixture();
    const logged = vi.fn();
    app.addHook("onRequest", async (request) => {
      (request.log as unknown as { error: unknown }).error = logged;
    });
    app.get("/api/boom", async () => {
      throw new Error("internal detail");
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/boom",
      headers: admin,
    });
    expect(response.statusCode).toBe(500);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logged.mock.calls[0]![0].err.message)).toContain(
      "internal detail",
    );
    await app.close();
    store.db.close();
  });

  it("keeps classified errors and validation messages intact", async () => {
    const { app, store, serverId, admin } = await fixture();
    const unsafeName = await app.inject({
      method: "GET",
      url: `/api/servers/${serverId}/files/content`,
      headers: admin,
    });
    expect(unsafeName.statusCode).toBe(400);
    expect(unsafeName.json().error).toBe("File path is required");
    const traversal = await app.inject({
      method: "GET",
      url: `/api/servers/${serverId}/files/content?path=..%2F..%2Fetc`,
      headers: admin,
    });
    expect(traversal.statusCode).toBe(400);
    expect(traversal.json().error).toBe("Invalid file path");
    const missing = await app.inject({
      method: "GET",
      url: "/api/servers/nope",
      headers: admin,
    });
    expect(missing.statusCode).toBe(404);
    const zod = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { role: "admin" },
    });
    expect(zod.statusCode).toBe(400);
    expect(zod.json().error).toEqual(expect.any(String));
    expect(zod.json().error.length).toBeGreaterThan(0);
    await app.close();
    store.db.close();
  });
});

describe("player mod requests", () => {
  it("hides internal failure text from players but not administrators", async () => {
    const { app, store, serverId, admin, player } = await fixture();
    const created = store.createModRequest(serverId, []);
    store.transitionModRequest(
      serverId,
      created.id,
      "pending",
      "failed",
      "0 of 1 installed. ENOENT /srv/instances/server-1/data/mods/x.jar",
    );
    const asPlayer = await app.inject({
      method: "GET",
      url: `/api/servers/${serverId}/mod-requests`,
      headers: player,
    });
    expect(asPlayer.statusCode).toBe(200);
    expect(asPlayer.body).not.toContain("/srv/instances");
    expect(asPlayer.json().requests[0].status).toBe("failed");
    expect(asPlayer.json().requests[0].error).toBeTruthy();
    const asAdmin = await app.inject({
      method: "GET",
      url: `/api/servers/${serverId}/mod-requests`,
      headers: admin,
    });
    expect(asAdmin.json().requests[0].error).toContain("/srv/instances");
    await app.close();
    store.db.close();
  });

  it("caps pending requests per server", async () => {
    const { app, store, serverId, player } = await fixture();
    config.MODRINTH_ENABLED = true;
    store.updatePanelSettings({ enabled: true, contact: "" });
    for (let i = 0; i < MAX_PENDING_MOD_REQUESTS_PER_SERVER; i += 1) {
      store.createModRequest(serverId, []);
    }
    const response = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/mod-requests`,
      headers: player,
      payload: {
        items: [
          { projectId: "abcdefgh", versionId: "abcdefgh", projectType: "mod" },
        ],
      },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json().error).toContain("pending mod requests");
    expect(store.countModRequests(serverId, "pending")).toBe(
      MAX_PENDING_MOD_REQUESTS_PER_SERVER,
    );
    // A resolved request frees a slot.
    const [first] = store.listModRequests(serverId);
    store.transitionModRequest(serverId, first!.id, "pending", "declined");
    const retry = await app.inject({
      method: "POST",
      url: `/api/servers/${serverId}/mod-requests`,
      headers: player,
      payload: {
        items: [
          { projectId: "abcdefgh", versionId: "abcdefgh", projectType: "mod" },
        ],
      },
    });
    expect(retry.statusCode).toBe(201);
    await app.close();
    store.db.close();
  });
});

describe("file save concurrency", () => {
  it("requires expectedModifiedAt and rejects stale values", async () => {
    const { app, store, serverId, admin } = await fixture();
    const data = instancePaths(config.instancesRoot, serverId).data;
    await writeFile(path.join(data, "server.properties"), "a=1\n");
    const read = await app.inject({
      method: "GET",
      url: `/api/servers/${serverId}/files/content?path=server.properties`,
      headers: admin,
    });
    const { modifiedAt } = read.json();
    const url = `/api/servers/${serverId}/files/content`;
    const missing = await app.inject({
      method: "PUT",
      url,
      headers: admin,
      payload: { path: "server.properties", content: "a=2\n" },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toContain("expectedModifiedAt");
    const stale = await app.inject({
      method: "PUT",
      url,
      headers: admin,
      payload: {
        path: "server.properties",
        content: "a=2\n",
        expectedModifiedAt: "2000-01-01T00:00:00.000Z",
      },
    });
    expect(stale.statusCode).toBe(409);
    const ok = await app.inject({
      method: "PUT",
      url,
      headers: admin,
      payload: {
        path: "server.properties",
        content: "a=2\n",
        expectedModifiedAt: modifiedAt,
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().content).toBe("a=2\n");
    await app.close();
    store.db.close();
  });
});

describe("login timing", () => {
  it("verifies against a dummy hash when player access is disabled", async () => {
    const { app, store } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { role: "player", password: "some password 123" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("Invalid password");
    const calls = vi.mocked(argon2.verify).mock.calls;
    expect(calls).toHaveLength(1);
    expect(String(calls[0]![0])).toMatch(/^\$argon2id\$/);
    await app.close();
    store.db.close();
  });
});

describe("trusted proxy addresses", () => {
  it("trusts loopback and private networks only", () => {
    for (const address of [
      "127.0.0.1",
      "172.18.0.5",
      "10.1.2.3",
      "192.168.1.10",
      "::1",
      "::ffff:172.18.0.5",
      "fd00::1",
    ]) {
      expect(isTrustedProxyAddress(address)).toBe(true);
    }
    for (const address of [
      "8.8.8.8",
      "172.32.0.1",
      "::ffff:8.8.8.8",
      "2001:4860::1",
      "not-an-ip",
    ]) {
      expect(isTrustedProxyAddress(address)).toBe(false);
    }
  });
});
