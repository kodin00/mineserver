import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { open } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { pathExists } from "./utils.js";
import {
  ModrinthClient,
  type FetchLike,
  type ModrinthClientOptions,
} from "./modrinth.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempFile() {
  const root = await mkdtemp(path.join(tmpdir(), "mineserver-modrinth-"));
  roots.push(root);
  const target = path.join(root, "download.bin");
  const handle = await open(target, "wx", 0o600);
  return { path: target, stream: handle.createWriteStream() };
}

interface Harness {
  client: ModrinthClient;
  calls: Array<{ url: string; headers: Record<string, string> }>;
  setNow(value: number): void;
}

function harness(
  responder: (url: string) => Response | Promise<Response>,
  overrides: Partial<ModrinthClientOptions> = {},
): Harness {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let now = 1_000_000;
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    return responder(url);
  };
  const client = new ModrinthClient({
    credentials: () => ({
      userAgent: "kodin00/mineserver-panel/0.1.0 (test)",
      token: null,
    }),
    baseUrl: "https://api.modrinth.com/v2",
    cdnHost: "cdn.modrinth.com",
    requestsPerMinute: 120,
    apiTimeoutMs: 5000,
    downloadTimeoutMs: 5000,
    maxFileBytes: 1024 * 1024,
    fetch: fetchFn,
    now: () => now,
    ...overrides,
  });
  return { client, calls, setNow: (value) => (now = value) };
}

function json(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

const searchPayload = {
  hits: [
    {
      project_id: "AABBCCDD",
      slug: "sodium",
      project_type: "mod",
      all_project_types: ["mod"],
      title: "Sodium",
      description: "Rendering engine",
      author: "jellysquid3",
      categories: ["optimization", "fabric"],
      display_categories: ["optimization"],
      versions: ["1.21.1"],
      downloads: 42,
      follows: 7,
      icon_url: "https://cdn.modrinth.com/icon.png",
      date_modified: "2026-01-01T00:00:00Z",
      license: "LGPL-3.0",
      client_side: "required",
      server_side: "unsupported",
      unexpected_new_field: "ignored",
    },
  ],
  offset: 0,
  limit: 20,
  total_hits: 1,
};

const versionPayload = {
  id: "Nlt8gI9z",
  project_id: "P7dR8mSH",
  name: "Fabric API 0.116.15",
  version_number: "0.116.15+1.21.1",
  version_type: "release",
  loaders: ["fabric"],
  game_versions: ["1.21.1"],
  date_published: "2026-01-01T00:00:00Z",
  downloads: 10,
  files: [
    {
      url: "https://cdn.modrinth.com/data/P7dR8mSH/versions/Nlt8gI9z/fabric-api.jar",
      filename: "fabric-api.jar",
      primary: true,
      size: 4,
      hashes: { sha512: "AB".repeat(64), sha1: "CD".repeat(20) },
    },
  ],
  dependencies: [],
};

const searchInput = {
  query: "sodium",
  serverType: "FABRIC" as const,
  gameVersion: "1.21.1",
  projectType: "mod" as const,
  categories: [],
  sort: "relevance" as const,
  limit: 20,
  offset: 0,
};

describe("ModrinthClient requests", () => {
  it("sends the required User-Agent and the derived facets", async () => {
    const { client, calls } = harness(() => json(searchPayload));
    await client.search(searchInput);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["user-agent"]).toBe(
      "kodin00/mineserver-panel/0.1.0 (test)",
    );
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe("/v2/search");
    expect(JSON.parse(url.searchParams.get("facets")!)).toEqual([
      ["project_type:mod"],
      ["categories:fabric"],
      ["versions:1.21.1"],
      ["server_side!=unsupported"],
    ]);
    expect(url.searchParams.get("index")).toBe("relevance");
  });

  it("normalizes hits, tolerates new fields and reports version applicability", async () => {
    const { client } = harness(() => json(searchPayload));
    const result = await client.search(searchInput);
    expect(result.totalHits).toBe(1);
    expect(result.gameVersionApplied).toBe(true);
    const hit = result.hits[0]!;
    expect(hit).not.toHaveProperty("unexpected_new_field");
    expect(hit.projectId).toBe("AABBCCDD");
    expect(hit.allProjectTypes).toEqual(["mod"]);
    expect(hit.iconUrl).toBe("https://cdn.modrinth.com/icon.png");
  });

  it("reports gameVersionApplied false when the server tracks LATEST", async () => {
    const { client } = harness(() => json(searchPayload));
    const result = await client.search({
      ...searchInput,
      gameVersion: "LATEST",
    });
    expect(result.gameVersionApplied).toBe(false);
    expect(result.appliedFacets.flat()).not.toContain("versions:LATEST");
  });

  it("drops a non-https icon rather than putting it in an img src", async () => {
    const payload = {
      ...searchPayload,
      hits: [{ ...searchPayload.hits[0], icon_url: "javascript:alert(1)" }],
    };
    const { client } = harness(() => json(payload));
    const result = await client.search(searchInput);
    expect(result.hits[0]!.iconUrl).toBeNull();
  });

  it("survives a hit missing every optional field", async () => {
    const payload = { hits: [{ project_id: "X", slug: "y" }] };
    const { client } = harness(() => json(payload));
    const result = await client.search(searchInput);
    expect(result.hits[0]!.title).toBe("");
    expect(result.hits[0]!.author).toBeNull();
    expect(result.hits[0]!.allProjectTypes).toEqual(["mod"]);
  });

  it("JSON-encodes the loader filter so datapack zips are selectable", async () => {
    const { client, calls } = harness(() => json([versionPayload]));
    await client.listVersions({
      idOrSlug: "terralith",
      serverType: "PAPER",
      gameVersion: "1.21.1",
      projectType: "datapack",
    });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("loaders")).toBe('["datapack"]');
    expect(url.searchParams.get("game_versions")).toBe('["1.21.1"]');
  });

  it("drops version files with no sha512 to verify against", async () => {
    const payload = {
      ...versionPayload,
      files: [
        { ...versionPayload.files[0], hashes: { sha1: "aa" } },
        versionPayload.files[0],
      ],
    };
    const { client } = harness(() => json(payload));
    const version = await client.getVersion("Nlt8gI9z");
    expect(version.files).toHaveLength(1);
    expect(version.files[0]!.sha512).toBe("ab".repeat(64));
  });
});

describe("ModrinthClient caching", () => {
  it("serves a repeated search from cache and refetches after the TTL", async () => {
    const { client, calls, setNow } = harness(() => json(searchPayload));
    await client.search(searchInput);
    await client.search(searchInput);
    expect(calls).toHaveLength(1);
    setNow(1_000_000 + 6 * 60_000);
    await client.search(searchInput);
    expect(calls).toHaveLength(2);
  });

  it("collapses concurrent identical searches into one request", async () => {
    const { client, calls } = harness(() => json(searchPayload));
    await Promise.all([client.search(searchInput), client.search(searchInput)]);
    expect(calls).toHaveLength(1);
  });

  it("does not cache a failure", async () => {
    let fail = true;
    const { client, calls } = harness(() =>
      fail ? new Response("nope", { status: 500 }) : json(searchPayload),
    );
    await expect(client.search(searchInput)).rejects.toThrow();
    fail = false;
    await expect(client.search(searchInput)).resolves.toBeDefined();
    expect(calls).toHaveLength(2);
  });
});

describe("ModrinthClient rate limiting", () => {
  it("refuses locally once the token bucket is empty", async () => {
    const { client, calls } = harness(() => json(searchPayload), {
      requestsPerMinute: 2,
    });
    await client.search({ ...searchInput, query: "a" });
    await client.search({ ...searchInput, query: "b" });
    await expect(
      client.search({ ...searchInput, query: "c" }),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(calls).toHaveLength(2);
  });

  it("turns an upstream 429 into a 503 and then short-circuits", async () => {
    const { client, calls } = harness(
      () =>
        new Response("slow down", {
          status: 429,
          headers: { "x-ratelimit-reset": "30" },
        }),
    );
    await expect(
      client.search({ ...searchInput, query: "a" }),
    ).rejects.toMatchObject({ statusCode: 503, retryAfterSeconds: 30 });
    expect(calls).toHaveLength(1);
    await expect(
      client.search({ ...searchInput, query: "b" }),
    ).rejects.toMatchObject({ statusCode: 503 });
    // The breaker is open, so no further upstream traffic is generated.
    expect(calls).toHaveLength(1);
  });

  it("opens the breaker when a success reports no remaining budget", async () => {
    const { client, calls } = harness(() =>
      json(searchPayload, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "20",
      }),
    );
    await client.search({ ...searchInput, query: "a" });
    await expect(
      client.search({ ...searchInput, query: "b" }),
    ).rejects.toMatchObject({ statusCode: 503, retryAfterSeconds: 20 });
    expect(calls).toHaveLength(1);
  });
});

describe("ModrinthClient error mapping", () => {
  it.each([
    [404, 404],
    [400, 400],
    [500, 502],
    [503, 502],
  ])("maps upstream %s to %s", async (upstream, expected) => {
    const { client } = harness(() => new Response("x", { status: upstream }));
    await expect(client.search(searchInput)).rejects.toMatchObject({
      statusCode: expected,
    });
  });

  it("maps a timeout to 502", async () => {
    const { client } = harness(() => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    await expect(client.search(searchInput)).rejects.toMatchObject({
      statusCode: 502,
    });
  });

  it("maps an unparseable payload to 502", async () => {
    const { client } = harness(() => json({ hits: "not-an-array" }));
    await expect(client.search(searchInput)).rejects.toMatchObject({
      statusCode: 502,
    });
  });
});

describe("ModrinthClient credentials", () => {
  it("sends the token to the API but never to the file CDN", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const body = "jar!";
    const client = new ModrinthClient({
      credentials: () => ({ userAgent: "panel/1 (test)", token: "mrp_secret" }),
      baseUrl: "https://api.modrinth.com/v2",
      cdnHost: "cdn.modrinth.com",
      requestsPerMinute: 120,
      apiTimeoutMs: 5000,
      downloadTimeoutMs: 5000,
      maxFileBytes: 1024,
      now: () => 1_000_000,
      fetch: async (url, init) => {
        calls.push({ url, headers: init?.headers ?? {} });
        return url.includes("/search")
          ? json(searchPayload)
          : new Response(body, { status: 200 });
      },
    });
    await client.search(searchInput);
    expect(calls[0]!.headers["authorization"]).toBe("mrp_secret");

    const temp = await tempFile();
    await client.downloadFile(
      {
        url: "https://cdn.modrinth.com/a.jar",
        filename: "a.jar",
        sizeBytes: body.length,
        sha512: createHash("sha512").update(body).digest("hex"),
        sha1: null,
      },
      temp,
    );
    expect(calls[1]!.headers["authorization"]).toBeUndefined();
    expect(calls[1]!.headers["user-agent"]).toBe("panel/1 (test)");
  });

  it("drops cached answers when invalidated, because a token changes them", async () => {
    const { client, calls } = harness(() => json(searchPayload));
    await client.search(searchInput);
    await client.search(searchInput);
    expect(calls).toHaveLength(1);
    client.invalidate();
    await client.search(searchInput);
    expect(calls).toHaveLength(2);
  });
});

describe("ModrinthClient downloadFile", () => {
  const body = "jar!";
  const sha512 = createHash("sha512").update(body).digest("hex");
  const sha1 = createHash("sha1").update(body).digest("hex");
  const expected = {
    url: "https://cdn.modrinth.com/data/AA/versions/BB/mod.jar",
    filename: "mod.jar",
    sizeBytes: body.length,
    sha512,
    sha1,
  };

  it("writes the file when both hashes match", async () => {
    const { client } = harness(() => new Response(body, { status: 200 }));
    const temp = await tempFile();
    await client.downloadFile(expected, temp);
    expect(await readFile(temp.path, "utf8")).toBe(body);
  });

  it("removes the temp file when the hash does not match", async () => {
    const { client } = harness(() => new Response("tampered", { status: 200 }));
    const temp = await tempFile();
    await expect(
      client.downloadFile({ ...expected, sizeBytes: 8 }, temp),
    ).rejects.toThrow(/integrity check/);
    expect(await pathExists(temp.path)).toBe(false);
  });

  it("rejects a body longer than declared", async () => {
    const { client } = harness(
      () => new Response("far too much data", { status: 200 }),
    );
    const temp = await tempFile();
    await expect(client.downloadFile(expected, temp)).rejects.toThrow();
    expect(await pathExists(temp.path)).toBe(false);
  });

  it("rejects a content-length that disagrees with the metadata", async () => {
    const { client } = harness(
      () =>
        new Response(body, {
          status: 200,
          headers: { "content-length": "9999" },
        }),
    );
    const temp = await tempFile();
    await expect(client.downloadFile(expected, temp)).rejects.toThrow(
      /expected size/,
    );
  });

  it("never dials a non-https or non-CDN host", async () => {
    const { client, calls } = harness(
      () => new Response(body, { status: 200 }),
    );
    for (const url of [
      "http://cdn.modrinth.com/a.jar",
      "https://cdn.modrinth.com.evil.test/a.jar",
      "https://evil.test/a.jar",
      "https://user:pass@cdn.modrinth.com/a.jar",
      "https://cdn.modrinth.com:8443/a.jar",
    ]) {
      const temp = await tempFile();
      await expect(
        client.downloadFile({ ...expected, url }, temp),
      ).rejects.toThrow();
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses to follow a redirect", async () => {
    const { client } = harness(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.test/a.jar" },
        }),
    );
    const temp = await tempFile();
    await expect(client.downloadFile(expected, temp)).rejects.toThrow(
      /redirected/,
    );
  });

  it("refuses a file larger than the configured cap before fetching", async () => {
    const { client, calls } = harness(
      () => new Response(body, { status: 200 }),
      {
        maxFileBytes: 2,
      },
    );
    const temp = await tempFile();
    await expect(client.downloadFile(expected, temp)).rejects.toMatchObject({
      statusCode: 413,
    });
    expect(calls).toHaveLength(0);
  });
});
