import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ServerConfigSchema } from "@mineserver/shared";
import { buildApp } from "./app.js";
import { instancePaths } from "./compose.js";
import { config } from "./config.js";
import { Store } from "./db.js";
import type { ComposeManager } from "./docker.js";
import { JobRunner } from "./jobs.js";
import { sha256 } from "./utils.js";

const roots: string[] = [];
const originalInstancesRoot = config.instancesRoot;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "mineserver-share-"));
  roots.push(root);
  config.instancesRoot = path.join(root, "instances");
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
    docker: {} as ComposeManager,
    jobs: new JobRunner(store),
  });
  return { app, store, serverId, sessionToken, csrfToken };
}

afterEach(async () => {
  config.instancesRoot = originalInstancesRoot;
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
