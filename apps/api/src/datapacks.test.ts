import path from "node:path";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ZipArchive } from "archiver";
import { createWriteStream } from "node:fs";
import { ServerConfigSchema } from "@mineserver/shared";
import {
  installDatapack,
  listDatapacks,
  parseLevelNameFromProperties,
  resolveLevelName,
} from "./datapacks.js";
import { createTempUpload } from "./addons.js";
import { config } from "./config.js";
import { pathExists } from "./utils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "mineserver-datapack-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true });
  return { root, dataDir, tempRoot: path.join(root, "temp") };
}

async function makeZip(
  target: string,
  files: Array<{ name: string; body: string }>,
) {
  const archive = new ZipArchive({ zlib: { level: 0 } });
  const out = createWriteStream(target);
  const done = new Promise<void>((resolve, reject) => {
    out.on("close", resolve);
    out.on("error", reject);
    archive.on("error", reject);
  });
  archive.pipe(out);
  for (const file of files) archive.append(file.body, { name: file.name });
  await archive.finalize();
  await done;
}

async function stageZip(
  tempRoot: string,
  files: Array<{ name: string; body: string }>,
) {
  const upload = await createTempUpload(tempRoot);
  upload.stream.end();
  await new Promise((resolve) => upload.stream.on("close", resolve));
  await makeZip(upload.path, files);
  return upload.path;
}

const manifest = {
  name: "pack.mcmeta",
  body: JSON.stringify({ pack: { pack_format: 48, description: "test" } }),
};

const serverConfig = (overrides: Record<string, unknown> = {}) =>
  ServerConfigSchema.parse({ name: "Test", type: "PAPER", ...overrides });

describe("parseLevelNameFromProperties", () => {
  it("reads the level name and tolerates CRLF", () => {
    expect(parseLevelNameFromProperties("level-name=my world\r\n")).toBe(
      "my world",
    );
  });

  it("ignores comments and unrelated keys", () => {
    expect(
      parseLevelNameFromProperties("#level-name=commented\nmotd=hi\n"),
    ).toBeNull();
  });

  it("refuses a traversal attempt rather than trusting the file", () => {
    expect(parseLevelNameFromProperties("level-name=../../etc")).toBeNull();
    expect(parseLevelNameFromProperties("level-name=..")).toBeNull();
    expect(parseLevelNameFromProperties("level-name=a/b")).toBeNull();
  });
});

describe("resolveLevelName", () => {
  it("prefers pending panel config over what is on disk", async () => {
    const { dataDir } = await workspace();
    await writeFile(
      path.join(dataDir, "server.properties"),
      "level-name=ondisk",
    );
    await expect(
      resolveLevelName(
        dataDir,
        serverConfig({ customProperties: { "level-name": "pending" } }),
      ),
    ).resolves.toBe("pending");
  });

  it("falls back to the LEVEL env override", async () => {
    const { dataDir } = await workspace();
    await writeFile(
      path.join(dataDir, "server.properties"),
      "level-name=ondisk",
    );
    await expect(
      resolveLevelName(
        dataDir,
        serverConfig({ advancedEnv: { LEVEL: "fromenv" } }),
      ),
    ).resolves.toBe("fromenv");
  });

  it("uses server.properties when no config override exists", async () => {
    const { dataDir } = await workspace();
    await writeFile(
      path.join(dataDir, "server.properties"),
      "level-name=ondisk\n",
    );
    await expect(resolveLevelName(dataDir, serverConfig())).resolves.toBe(
      "ondisk",
    );
  });

  it("defaults to world when nothing says otherwise", async () => {
    const { dataDir } = await workspace();
    await expect(resolveLevelName(dataDir, serverConfig())).resolves.toBe(
      "world",
    );
  });

  it("ignores a hostile level-name on disk", async () => {
    const { dataDir } = await workspace();
    await writeFile(
      path.join(dataDir, "server.properties"),
      "level-name=../../../../etc\n",
    );
    await expect(resolveLevelName(dataDir, serverConfig())).resolves.toBe(
      "world",
    );
  });
});

describe("installDatapack", () => {
  it("installs into the world's datapacks directory", async () => {
    const { dataDir, tempRoot } = await workspace();
    await mkdir(path.join(dataDir, "world"), { recursive: true });
    const staged = await stageZip(tempRoot, [manifest]);
    const result = await installDatapack(staged, "pack.zip", dataDir, "world");
    expect(result).toMatchObject({ filename: "pack.zip", worldCreated: false });
    const target = path.join(dataDir, "world", "datapacks", "pack.zip");
    expect(await pathExists(target)).toBe(true);
    expect((await stat(target)).mode & 0o777).toBe(0o644);
    expect(await pathExists(staged)).toBe(false);
  });

  it("creates a world directory that does not exist yet", async () => {
    const { dataDir, tempRoot } = await workspace();
    const staged = await stageZip(tempRoot, [manifest]);
    const result = await installDatapack(staged, "pack.zip", dataDir, "fresh");
    expect(result.worldCreated).toBe(true);
    expect(
      await pathExists(path.join(dataDir, "fresh", "datapacks", "pack.zip")),
    ).toBe(true);
  });

  it("refuses to overwrite an existing datapack", async () => {
    const { dataDir, tempRoot } = await workspace();
    const first = await stageZip(tempRoot, [manifest]);
    await installDatapack(first, "pack.zip", dataDir, "world");
    const second = await stageZip(tempRoot, [manifest]);
    await expect(
      installDatapack(second, "pack.zip", dataDir, "world"),
    ).rejects.toThrow(/already exists/);
  });

  it("rejects a jar with a pointer to the add-ons flow", async () => {
    const { dataDir, tempRoot } = await workspace();
    const staged = await stageZip(tempRoot, [manifest]);
    await expect(
      installDatapack(staged, "mod.jar", dataDir, "world"),
    ).rejects.toThrow(/Only .zip datapacks/);
  });

  it("rejects a zip with no pack.mcmeta", async () => {
    const { dataDir, tempRoot } = await workspace();
    const staged = await stageZip(tempRoot, [
      { name: "readme.txt", body: "hi" },
    ]);
    await expect(
      installDatapack(staged, "pack.zip", dataDir, "world"),
    ).rejects.toThrow(/pack\.mcmeta/);
  });

  it("accepts a large pack with far more files than an upload batch allows", async () => {
    const { dataDir, tempRoot } = await workspace();
    // Real datapacks hold thousands of JSON files; Terralith alone has ~2000.
    const many = [
      manifest,
      ...Array.from({ length: 900 }, (_, index) => ({
        name: `data/pack/biome/${index}.json`,
        body: "{}",
      })),
    ];
    const staged = await stageZip(tempRoot, many);
    await expect(
      installDatapack(staged, "big.zip", dataDir, "world"),
    ).resolves.toMatchObject({ filename: "big.zip" });
  });

  it("still refuses an archive beyond the datapack file cap", async () => {
    const { dataDir, tempRoot } = await workspace();
    const original = config.MODRINTH_MAX_DATAPACK_FILES;
    config.MODRINTH_MAX_DATAPACK_FILES = 3;
    try {
      const staged = await stageZip(tempRoot, [
        manifest,
        { name: "a.json", body: "{}" },
        { name: "b.json", body: "{}" },
        { name: "c.json", body: "{}" },
      ]);
      await expect(
        installDatapack(staged, "big.zip", dataDir, "world"),
      ).rejects.toThrow(/more than 3 files/);
    } finally {
      config.MODRINTH_MAX_DATAPACK_FILES = original;
    }
  });

  it("lists installed datapacks", async () => {
    const { dataDir, tempRoot } = await workspace();
    const staged = await stageZip(tempRoot, [manifest]);
    await installDatapack(staged, "pack.zip", dataDir, "world");
    const listed = await listDatapacks(dataDir, "world");
    expect(listed.map((file) => file.name)).toEqual(["pack.zip"]);
    expect(listed[0]!.size).toBeGreaterThan(0);
  });

  it("returns an empty list when the world has no datapacks yet", async () => {
    const { dataDir } = await workspace();
    await expect(listDatapacks(dataDir, "world")).resolves.toEqual([]);
  });
});
