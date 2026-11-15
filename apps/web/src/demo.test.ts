import { describe, expect, it, vi } from "vitest";
import { demoFetch } from "./demo";

const call = async (path: string, method = "GET", body?: unknown) =>
  demoFetch(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("isolated demo", () => {
  it("rejects server creation without reaching the network", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const response = await call("/api/servers", "POST", { name: "Nope" });
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it("filters the catalog and simulates admin installs without network calls", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await call("/api/auth/login", "POST", { role: "admin" });
    const fabric = await (
      await call("/api/modrinth/search?projectType=mod&serverType=FABRIC")
    ).json();
    const paper = await (
      await call("/api/modrinth/search?projectType=plugin&serverType=PAPER")
    ).json();
    expect(fabric.hits).toHaveLength(3);
    expect(paper.hits).toHaveLength(0);
    const operation = await (
      await call("/api/servers/survival/modrinth/install", "POST", {
        versionId: "fabric-api-v1",
        projectType: "mod",
      })
    ).json();
    expect(operation.status).toBe("succeeded");
    expect(
      await (await call("/api/servers/survival/operations")).json(),
    ).toContainEqual(operation);
    expect(
      (
        await (await call("/api/servers/survival/marketplace/inventory")).json()
      ).items.some(
        (item: { projectId: string }) => item.projectId === "fabric-api",
      ),
    ).toBe(true);
    expect(
      (await (await call("/api/servers/survival")).json()).restartRequired,
    ).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it("keeps multi-mod requests across role switches and allows an admin decision", async () => {
    await call("/api/auth/login", "POST", { role: "player" });
    const created = await (
      await call("/api/servers/survival/mod-requests", "POST", {
        items: [
          {
            projectId: "ferrite-core",
            versionId: "ferrite-core-v1",
            projectType: "mod",
          },
          { projectId: "lithium", versionId: "lithium-v1", projectType: "mod" },
        ],
      })
    ).json();
    expect(created.items).toHaveLength(2);
    expect(
      (
        await call(
          `/api/servers/survival/mod-requests/${created.id}/approve`,
          "POST",
        )
      ).status,
    ).toBe(403);
    await call("/api/auth/login", "POST", { role: "admin" });
    const approved = await (
      await call(
        `/api/servers/survival/mod-requests/${created.id}/approve`,
        "POST",
      )
    ).json();
    expect(approved.status).toBe("approved");
    const inventory = await (
      await call("/api/servers/survival/marketplace/inventory")
    ).json();
    expect(
      inventory.items.map((item: { projectId: string }) => item.projectId),
    ).toEqual(expect.arrayContaining(["ferrite-core", "lithium"]));
    expect(
      (await (await call("/api/servers/survival")).json()).restartRequired,
    ).toBe(true);
    await call("/api/servers/survival/actions/restart", "POST");
    expect(
      (await (await call("/api/servers/survival")).json()).restartRequired,
    ).toBe(true);
    await call("/api/servers/survival/actions/rebuild", "POST");
    expect(
      (await (await call("/api/servers/survival")).json()).restartRequired,
    ).toBe(false);
    expect(
      (await (await call("/api/servers/survival/mod-requests")).json())
        .requests,
    ).toContainEqual(approved);
  });

  it("serves read-only world, backup and file fixtures", async () => {
    await call("/api/auth/login", "POST", { role: "admin" });
    const world = await (await call("/api/servers/survival/world")).json();
    expect(world).toMatchObject({ levelName: "world", exists: true });
    expect(world.canImport).toBe(false);
    const backups = await (await call("/api/servers/survival/backups")).json();
    expect(backups.length).toBeGreaterThan(0);
    expect(backups[0]).toEqual(
      expect.objectContaining({
        name: expect.any(String),
        size: expect.any(Number),
      }),
    );
    const root = await (await call("/api/servers/survival/files?path=")).json();
    expect(root.map((entry: { name: string }) => entry.name)).toEqual(
      expect.arrayContaining(["config", "server.properties", "world"]),
    );
    expect(root[0].type).toBe("directory");
    const nested = await (
      await call("/api/servers/survival/files?path=config")
    ).json();
    expect(nested[0].path).toBe("config/ferrite-core.mixin.properties");
    const document = await (
      await call("/api/servers/survival/files/content?path=server.properties")
    ).json();
    expect(document.content).toContain("server-port=25565");
    expect(typeof document.modifiedAt).toBe("string");
    const found = await (
      await call("/api/servers/survival/files/search?q=lithium")
    ).json();
    expect(found.map((entry: { path: string }) => entry.path)).toContain(
      "config/lithium.properties",
    );
    expect(
      (await call("/api/servers/survival/files/content?path=world/level.dat"))
        .status,
    ).toBe(404);
  });

  it("rejects mutations with a clear demo message and no network call", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await call("/api/auth/login", "POST", { role: "admin" });
    for (const [path, method, body] of [
      [
        "/api/servers/survival/players/actions",
        "POST",
        { action: "op", player: "Alex" },
      ],
      ["/api/servers/survival/whitelist/actions", "POST", { action: "on" }],
      [
        "/api/servers/survival/files/content",
        "PUT",
        { path: "ops.json", content: "[]" },
      ],
      ["/api/servers/survival/files", "DELETE", undefined],
      ["/api/servers/survival/actions/backup", "POST", undefined],
      ["/api/servers/survival/backups/x.tar.gz/restore", "POST", undefined],
      ["/api/servers/survival/world/import", "POST", undefined],
    ] as const) {
      const response = await call(path, method, body);
      expect(response.status, path).toBe(403);
      expect((await response.json()).error, path).toMatch(
        /not available in the demo/,
      );
    }
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});
