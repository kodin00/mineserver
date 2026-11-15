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
});
