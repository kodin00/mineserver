import { describe, expect, it } from "vitest";
import type { ModrinthVersionSummary } from "@mineserver/shared";
import {
  buildSearchQuery,
  describeVersionChannel,
  hasNextPage,
  isVersionInstalled,
  pageLabel,
  pickDefaultVersion,
  primaryFile,
  requiredDependencies,
} from "./modrinth";

const descriptor = {
  q: "sodium mod",
  projectType: "mod" as const,
  serverType: "FABRIC",
  gameVersion: "1.21.1",
  sort: "downloads" as const,
  offset: 0,
  limit: 20,
  categories: [] as string[],
};

function version(
  overrides: Partial<ModrinthVersionSummary> = {},
): ModrinthVersionSummary {
  return {
    id: "aaaaaaaa",
    projectId: "bbbbbbbb",
    name: "v1",
    versionNumber: "1.0.0",
    versionType: "release",
    loaders: ["fabric"],
    gameVersions: ["1.21.1"],
    datePublished: "2026-01-01T00:00:00Z",
    downloads: 1,
    files: [
      {
        url: "https://cdn.modrinth.com/a.jar",
        filename: "Mod-1.0.0.jar",
        primary: true,
        size: 10,
        sha512: "ab",
        sha1: null,
      },
    ],
    dependencies: [],
    ...overrides,
  };
}

describe("buildSearchQuery", () => {
  it("encodes the query and omits categories when empty", () => {
    const params = new URLSearchParams(buildSearchQuery(descriptor));
    expect(params.get("q")).toBe("sodium mod");
    expect(params.get("projectType")).toBe("mod");
    expect(params.get("sort")).toBe("downloads");
    expect(params.has("categories")).toBe(false);
  });

  it("clamps a limit and offset the backend would otherwise reject", () => {
    const params = new URLSearchParams(
      buildSearchQuery({ ...descriptor, limit: 5000, offset: -10 }),
    );
    expect(params.get("limit")).toBe("50");
    expect(params.get("offset")).toBe("0");
    const deep = new URLSearchParams(
      buildSearchQuery({ ...descriptor, offset: 99999 }),
    );
    expect(deep.get("offset")).toBe("500");
  });

  it("joins categories into one parameter", () => {
    const params = new URLSearchParams(
      buildSearchQuery({ ...descriptor, categories: ["utility", "magic"] }),
    );
    expect(params.get("categories")).toBe("utility,magic");
  });
});

describe("pageLabel", () => {
  it.each([
    [0, 20, 812, "Showing 1–20 of 812"],
    [800, 12, 812, "Showing 801–812 of 812"],
    [0, 0, 0, "No results"],
  ])("labels offset %s count %s", (offset, count, total, expected) => {
    expect(pageLabel(offset, count, total)).toBe(expected);
  });
});

describe("hasNextPage", () => {
  it("stops exactly at the last result", () => {
    expect(hasNextPage(0, 20, 40)).toBe(true);
    expect(hasNextPage(20, 20, 40)).toBe(false);
    expect(hasNextPage(0, 0, 0)).toBe(false);
  });

  it("stops before the backend's offset ceiling", () => {
    expect(hasNextPage(500, 20, 100_000)).toBe(false);
  });
});

describe("primaryFile and pickDefaultVersion", () => {
  it("prefers the primary file", () => {
    const chosen = primaryFile(
      version({
        files: [
          {
            url: "u",
            filename: "sources.jar",
            primary: false,
            size: 1,
            sha512: "a",
            sha1: null,
          },
          {
            url: "u",
            filename: "mod.jar",
            primary: true,
            size: 1,
            sha512: "a",
            sha1: null,
          },
        ],
      }),
    );
    expect(chosen?.filename).toBe("mod.jar");
  });

  it("returns null when a version has no files", () => {
    expect(primaryFile(version({ files: [] }))).toBeNull();
  });

  it("prefers a release but accepts a prerelease when that is all there is", () => {
    expect(
      pickDefaultVersion([
        version({ id: "beta1", versionType: "beta" }),
        version({ id: "rel1", versionType: "release" }),
      ])?.id,
    ).toBe("rel1");
    expect(
      pickDefaultVersion([
        version({ id: "alpha1", versionType: "alpha" }),
        version({ id: "beta1", versionType: "beta" }),
      ])?.id,
    ).toBe("beta1");
    expect(pickDefaultVersion([])).toBeNull();
  });
});

describe("requiredDependencies", () => {
  it("keeps only required entries and dedupes by project", () => {
    const result = requiredDependencies(
      version({
        dependencies: [
          {
            projectId: "a",
            versionId: null,
            title: "A",
            dependencyType: "required",
          },
          {
            projectId: "a",
            versionId: null,
            title: "A",
            dependencyType: "required",
          },
          {
            projectId: "b",
            versionId: null,
            title: "B",
            dependencyType: "optional",
          },
          {
            projectId: "c",
            versionId: null,
            title: "C",
            dependencyType: "embedded",
          },
        ],
      }),
    );
    expect(result.map((entry) => entry.projectId)).toEqual(["a"]);
  });

  it("never drops an unidentified required dependency", () => {
    const result = requiredDependencies(
      version({
        dependencies: [
          {
            projectId: null,
            versionId: null,
            title: null,
            dependencyType: "required",
          },
          {
            projectId: null,
            versionId: null,
            title: null,
            dependencyType: "required",
          },
        ],
      }),
    );
    expect(result).toHaveLength(2);
  });
});

describe("isVersionInstalled", () => {
  const installed = new Set(["mod-1.0.0.jar"]);

  it("matches case-insensitively and only on an exact filename", () => {
    expect(isVersionInstalled("Mod-1.0.0.jar", installed)).toBe(true);
    expect(isVersionInstalled("mod-1.0.1.jar", installed)).toBe(false);
    expect(isVersionInstalled("mod", installed)).toBe(false);
    expect(isVersionInstalled(null, installed)).toBe(false);
  });
});

describe("describeVersionChannel", () => {
  it("labels the known channels", () => {
    expect(describeVersionChannel("release")).toBe("Release");
    expect(describeVersionChannel("beta")).toBe("Beta");
    expect(describeVersionChannel("alpha")).toBe("Alpha");
  });
});
