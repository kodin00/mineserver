import { describe, expect, it } from "vitest";
import {
  buildModrinthFacets,
  concreteGameVersion,
  loaderFacetsFor,
  marketplaceTargetFor,
  modrinthProjectTypes,
  parseSearchCategories,
  supportedMarketplaceTypes,
} from "./modrinth.js";
import { serverTypes } from "./index.js";

describe("concreteGameVersion", () => {
  it.each([
    ["1.21.1", "1.21.1"],
    ["1.21", "1.21"],
    ["  1.20.4  ", "1.20.4"],
    ["LATEST", null],
    ["SNAPSHOT", null],
    ["24w40a", null],
    ["", null],
  ])("maps %s to %s", (input, expected) => {
    expect(concreteGameVersion(input)).toBe(expected);
  });
});

describe("loaderFacetsFor", () => {
  it("narrows mods to the server's own loader", () => {
    expect(loaderFacetsFor("FABRIC", "mod")).toEqual(["fabric"]);
    expect(loaderFacetsFor("FORGE", "mod")).toEqual(["forge"]);
    // Not every Forge mod runs on NeoForge, so Forge is deliberately excluded.
    expect(loaderFacetsFor("NEOFORGE", "mod")).toEqual(["neoforge"]);
  });

  it("accepts the Bukkit plugin family on Paper but not Purpur or Folia", () => {
    expect(loaderFacetsFor("PAPER", "plugin")).toEqual([
      "paper",
      "bukkit",
      "spigot",
    ]);
  });

  it("treats datapack as a loader regardless of server type", () => {
    for (const type of serverTypes) {
      expect(loaderFacetsFor(type, "datapack")).toEqual(["datapack"]);
    }
  });

  it("has no loader facet for client-side content", () => {
    expect(loaderFacetsFor("FABRIC", "resourcepack")).toEqual([]);
    expect(loaderFacetsFor("FABRIC", "shader")).toEqual([]);
  });
});

describe("buildModrinthFacets", () => {
  it("ANDs project type, loader, game version and server support", () => {
    expect(
      buildModrinthFacets({
        serverType: "FABRIC",
        gameVersion: "1.21.1",
        projectType: "mod",
      }),
    ).toEqual([
      ["project_type:mod"],
      ["categories:fabric"],
      ["versions:1.21.1"],
      ["server_side!=unsupported"],
    ]);
  });

  it("ORs the Paper plugin loaders inside one group", () => {
    const facets = buildModrinthFacets({
      serverType: "PAPER",
      gameVersion: "1.21.1",
      projectType: "plugin",
    });
    expect(facets[0]).toEqual(["project_type:plugin"]);
    expect(facets[1]).toEqual([
      "categories:paper",
      "categories:bukkit",
      "categories:spigot",
    ]);
  });

  it("uses the datapack loader facet", () => {
    const facets = buildModrinthFacets({
      serverType: "VANILLA",
      gameVersion: "1.21.1",
      projectType: "datapack",
    });
    expect(facets).toContainEqual(["categories:datapack"]);
    expect(facets[0]).toEqual(["project_type:datapack"]);
  });

  it("omits the version facet when the server tracks a moving target", () => {
    for (const version of ["LATEST", "SNAPSHOT", "24w40a"]) {
      const facets = buildModrinthFacets({
        serverType: "FABRIC",
        gameVersion: version,
        projectType: "mod",
      });
      expect(facets.flat().some((f) => f.startsWith("versions:"))).toBe(false);
    }
  });

  it("skips version and server-support facets for shaders", () => {
    const facets = buildModrinthFacets({
      serverType: "FABRIC",
      gameVersion: "1.21.1",
      projectType: "shader",
    });
    expect(facets).toEqual([["project_type:shader"]]);
  });

  it("appends each caller category as its own ANDed group", () => {
    const facets = buildModrinthFacets({
      serverType: "FABRIC",
      gameVersion: "1.21.1",
      projectType: "mod",
      categories: ["optimization", "utility"],
    });
    expect(facets).toContainEqual(["categories:optimization"]);
    expect(facets).toContainEqual(["categories:utility"]);
  });

  it("rejects a category that could inject facet syntax", () => {
    expect(() =>
      buildModrinthFacets({
        serverType: "FABRIC",
        gameVersion: "1.21.1",
        projectType: "mod",
        categories: ['fabric"],["project_type:modpack'],
      }),
    ).toThrow(/Invalid marketplace category/);
  });
});

describe("parseSearchCategories", () => {
  it("splits, trims and caps the list", () => {
    expect(parseSearchCategories(undefined)).toEqual([]);
    expect(parseSearchCategories(" a , b ,, c ")).toEqual(["a", "b", "c"]);
    expect(parseSearchCategories("a,b,c,d,e,f,g")).toHaveLength(5);
  });
});

describe("marketplaceTargetFor", () => {
  it("routes installable types to a directory", () => {
    expect(marketplaceTargetFor("FABRIC", "mod")).toBe("addons");
    expect(marketplaceTargetFor("PAPER", "plugin")).toBe("addons");
    expect(marketplaceTargetFor("VANILLA", "datapack")).toBe("datapacks");
  });

  it("never claims a server can install client-side content", () => {
    for (const type of serverTypes) {
      expect(marketplaceTargetFor(type, "resourcepack")).toBe("browse-only");
      expect(marketplaceTargetFor(type, "shader")).toBe("browse-only");
    }
  });

  it("rejects loader content a server type cannot load", () => {
    expect(marketplaceTargetFor("VANILLA", "mod")).toBe("unsupported");
    expect(marketplaceTargetFor("VANILLA", "plugin")).toBe("unsupported");
    expect(marketplaceTargetFor("FABRIC", "plugin")).toBe("unsupported");
    expect(marketplaceTargetFor("PAPER", "mod")).toBe("unsupported");
  });
});

describe("supportedMarketplaceTypes", () => {
  it.each([
    ["VANILLA", ["datapack", "resourcepack", "shader"]],
    ["PAPER", ["plugin", "datapack", "resourcepack", "shader"]],
    ["FABRIC", ["mod", "datapack", "resourcepack", "shader"]],
    ["FORGE", ["mod", "datapack", "resourcepack", "shader"]],
    ["NEOFORGE", ["mod", "datapack", "resourcepack", "shader"]],
  ] as const)("lists %s types", (type, expected) => {
    expect(supportedMarketplaceTypes(type)).toEqual(expected);
  });

  it("only ever returns known project types", () => {
    for (const type of serverTypes) {
      for (const projectType of supportedMarketplaceTypes(type)) {
        expect(modrinthProjectTypes).toContain(projectType);
      }
    }
  });
});
