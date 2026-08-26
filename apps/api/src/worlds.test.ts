import path from "node:path";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { ZipArchive } from "archiver";
import { afterEach, describe, expect, it } from "vitest";
import { ServerConfigSchema } from "@mineserver/shared";
import { instancePaths } from "./compose.js";
import { config } from "./config.js";
import type { ComposeManager } from "./docker.js";
import {
  createWorldExport,
  extractInspectedWorld,
  importWorld,
  inspectWorldZip,
  worldInfo,
} from "./worlds.js";

const roots: string[] = [];
const originalMaxFiles = config.MAX_ZIP_FILES;
const originalMaxExpanded = config.MAX_ZIP_EXPANDED_BYTES;

afterEach(async () => {
  config.MAX_ZIP_FILES = originalMaxFiles;
  config.MAX_ZIP_EXPANDED_BYTES = originalMaxExpanded;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "mineserver-world-"));
  roots.push(root);
  const paths = instancePaths(root, "test-server");
  await mkdir(paths.data, { recursive: true });
  return { root, paths };
}

function replaceAllExact(raw: Buffer, source: string, replacement: string) {
  const from = Buffer.from(source);
  const to = Buffer.from(replacement);
  if (from.length !== to.length)
    throw new Error("Replacement must keep ZIP layout");
  let found = 0;
  for (
    let offset = raw.indexOf(from);
    offset >= 0;
    offset = raw.indexOf(from, offset + 1)
  ) {
    to.copy(raw, offset);
    found += 1;
  }
  if (!found) throw new Error(`ZIP fixture entry not found: ${source}`);
}

function patchEntryAttributes(raw: Buffer, name: string, mode: number) {
  const signature = 0x02014b50;
  for (let offset = 0; offset <= raw.length - 46; offset += 1) {
    if (raw.readUInt32LE(offset) !== signature) continue;
    const nameLength = raw.readUInt16LE(offset + 28);
    const entryName = raw.subarray(offset + 46, offset + 46 + nameLength);
    if (entryName.equals(Buffer.from(name))) {
      raw.writeUInt32LE((mode << 16) >>> 0, offset + 38);
      return;
    }
  }
  throw new Error(`ZIP fixture entry not found: ${name}`);
}

function patchEntryEncryption(raw: Buffer, name: string) {
  const centralSignature = 0x02014b50;
  for (let offset = 0; offset <= raw.length - 46; offset += 1) {
    if (raw.readUInt32LE(offset) !== centralSignature) continue;
    const nameLength = raw.readUInt16LE(offset + 28);
    const entryName = raw.subarray(offset + 46, offset + 46 + nameLength);
    if (!entryName.equals(Buffer.from(name))) continue;
    raw.writeUInt16LE(raw.readUInt16LE(offset + 8) | 0x1, offset + 8);
    const localOffset = raw.readUInt32LE(offset + 42);
    raw.writeUInt16LE(raw.readUInt16LE(localOffset + 6) | 0x1, localOffset + 6);
    return;
  }
  throw new Error(`ZIP fixture entry not found: ${name}`);
}

async function makeZip(
  target: string,
  entries: Array<{
    name: string;
    body?: string;
    mode?: number;
    type?: "file" | "directory";
  }>,
) {
  const archive = new ZipArchive({ zlib: { level: 0 } });
  const output = createWriteStream(target);
  const complete = new Promise<void>((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
  });
  archive.pipe(output);
  for (const entry of entries) {
    if (entry.type === "directory") {
      archive.append("", {
        name: `${entry.name.replace(/\/$/, "")}/`,
        type: "directory",
      });
    } else {
      archive.append(entry.body ?? "", {
        name: entry.name,
        ...(entry.mode === undefined ? {} : { mode: entry.mode }),
      });
    }
  }
  await archive.finalize();
  await complete;
}

const serverConfig = ServerConfigSchema.parse({ name: "Test", type: "PAPER" });
const stoppedDocker = {
  status: async () => ({ state: "stopped" as const, exists: true }),
} as unknown as ComposeManager;

describe("world ZIP inspection", () => {
  it("accepts root contents and exactly one wrapper directory", async () => {
    const { root } = await workspace();
    const flat = path.join(root, "flat.zip");
    const wrapped = path.join(root, "wrapped.zip");
    await makeZip(flat, [
      { name: "level.dat", body: "level" },
      { name: "region/r.0.0.mca", body: "region" },
    ]);
    await makeZip(wrapped, [
      { name: "My World/level.dat", body: "level" },
      { name: "My World/data/map.dat", body: "map" },
      { name: "__MACOSX/._level.dat", body: "metadata" },
    ]);

    await expect(inspectWorldZip(flat)).resolves.toMatchObject({ root: "" });
    await expect(inspectWorldZip(wrapped)).resolves.toMatchObject({
      root: "My World",
    });
  });

  it("rejects unsafe, ambiguous, nested and duplicate roots", async () => {
    const { root } = await workspace();
    const cases = [
      {
        name: "ambiguous.zip",
        files: [
          { name: "one/level.dat", body: "one" },
          { name: "two/level.dat", body: "two" },
        ],
        message: /multiple possible world roots/i,
      },
      {
        name: "nested.zip",
        files: [{ name: "a/b/level.dat", body: "level" }],
        message: /one wrapper directory/i,
      },
      {
        name: "duplicate.zip",
        files: [
          { name: "level.dat", body: "one" },
          { name: "LEVEL.DAT", body: "two" },
        ],
        message: /duplicate path/i,
      },
    ];
    for (const item of cases) {
      const zip = path.join(root, item.name);
      await makeZip(zip, item.files);
      await expect(inspectWorldZip(zip)).rejects.toThrow(item.message);
    }

    const safe = path.join(root, "raw-safe.zip");
    await makeZip(safe, [
      { name: "level.dat", body: "level" },
      { name: "inside.txt", body: "bad" },
    ]);
    const raw = await readFile(safe);
    replaceAllExact(raw, "inside.txt", "../outside");
    const traversal = path.join(root, "traversal.zip");
    await writeFile(traversal, raw);
    await expect(inspectWorldZip(traversal)).rejects.toThrow(
      /invalid relative path|unsafe ZIP path/i,
    );

    const absoluteRaw = await readFile(safe);
    replaceAllExact(absoluteRaw, "inside.txt", "/root/path");
    const absolute = path.join(root, "absolute.zip");
    await writeFile(absolute, absoluteRaw);
    await expect(inspectWorldZip(absolute)).rejects.toThrow(
      /absolute path|unsafe ZIP path/i,
    );

    const driveRaw = await readFile(safe);
    replaceAllExact(driveRaw, "inside.txt", "C:/escape.");
    const drive = path.join(root, "drive.zip");
    await writeFile(drive, driveRaw);
    await expect(inspectWorldZip(drive)).rejects.toThrow(
      /absolute path|unsafe ZIP path/i,
    );
  });

  it("rejects file and directory conflicts in either entry order", async () => {
    const { root } = await workspace();
    for (const [name, entries] of [
      [
        "file-first.zip",
        [
          { name: "level.dat", body: "level" },
          { name: "region", body: "file" },
          { name: "region/r.0.0.mca", body: "region" },
        ],
      ],
      [
        "child-first.zip",
        [
          { name: "level.dat", body: "level" },
          { name: "region/r.0.0.mca", body: "region" },
          { name: "region", body: "file" },
        ],
      ],
    ] as const) {
      const zip = path.join(root, name);
      await makeZip(zip, [...entries]);
      await expect(inspectWorldZip(zip)).rejects.toThrow(
        /file\/directory conflict/i,
      );
    }
  });

  it("rejects encrypted, symbolic-link and special entries", async () => {
    const { root } = await workspace();
    const encrypted = path.join(root, "encrypted.zip");
    await makeZip(encrypted, [
      { name: "level.dat", body: "level" },
      { name: "secret", body: "target" },
    ]);
    const encryptedRaw = await readFile(encrypted);
    patchEntryEncryption(encryptedRaw, "secret");
    await writeFile(encrypted, encryptedRaw);
    await expect(inspectWorldZip(encrypted)).rejects.toThrow(
      /encrypted|size mismatch/i,
    );

    for (const [name, mode, message] of [
      ["symlink", 0o120777, /symbolic link/i],
      ["socket1", 0o140777, /special entry/i],
    ] as const) {
      const zip = path.join(root, `${name}.zip`);
      await makeZip(zip, [
        { name: "level.dat", body: "level" },
        { name, body: "target" },
      ]);
      const raw = await readFile(zip);
      patchEntryAttributes(raw, name, mode);
      await writeFile(zip, raw);
      await expect(inspectWorldZip(zip)).rejects.toThrow(message);
    }
  });

  it("rejects empty worlds and configured file or expansion limits", async () => {
    const { root } = await workspace();
    const empty = path.join(root, "empty.zip");
    await makeZip(empty, [{ name: "level.dat", body: "" }]);
    await expect(inspectWorldZip(empty)).rejects.toThrow(/empty level\.dat/i);

    const large = path.join(root, "large.zip");
    await makeZip(large, [
      { name: "level.dat", body: "level" },
      { name: "region/a", body: "12345" },
    ]);
    config.MAX_ZIP_FILES = 1;
    await expect(inspectWorldZip(large)).rejects.toThrow(/more than 1 files/i);
    config.MAX_ZIP_FILES = originalMaxFiles;
    config.MAX_ZIP_EXPANDED_BYTES = 5;
    await expect(inspectWorldZip(large)).rejects.toThrow(/configured limit/i);
  });

  it("rejects immutable entry metadata changed after inspection", async () => {
    const { root } = await workspace();
    const archive = path.join(root, "changed.zip");
    await makeZip(archive, [
      { name: "level.dat", body: "level" },
      { name: "region/r.0.0.mca", body: "region" },
    ]);
    const inspected = await inspectWorldZip(archive);
    const replacement = path.join(root, "replacement.zip");
    await makeZip(replacement, [
      { name: "level.dat", body: "LEVEL" },
      { name: "region/r.0.0.mca", body: "REGION" },
    ]);
    await rename(replacement, archive);
    const destination = path.join(root, "extracted");
    await mkdir(destination);

    await expect(
      extractInspectedWorld(archive, inspected, destination),
    ).rejects.toThrow(/changed while it was being inspected/i);
  });

  it("rejects malformed archives", async () => {
    const { root } = await workspace();
    const target = path.join(root, "broken.zip");
    await writeFile(target, "not a zip");
    await expect(inspectWorldZip(target)).rejects.toThrow();
  });
});

describe("world import", () => {
  it("replaces only the active world, preserves other data, and leaves stopped", async () => {
    const { root, paths } = await workspace();
    await mkdir(path.join(paths.data, "world", "region"), { recursive: true });
    await writeFile(path.join(paths.data, "world", "level.dat"), "old");
    await writeFile(path.join(paths.data, "server.properties"), "motd=keep\n");
    const archive = path.join(root, "world.zip");
    await makeZip(archive, [
      { name: "Imported/level.dat", body: "new" },
      { name: "Imported/region/r.0.0.mca", body: "region" },
    ]);

    await expect(
      importWorld(
        "test-server",
        archive,
        paths,
        serverConfig,
        stoppedDocker,
        "world",
      ),
    ).resolves.toContain("remains stopped");
    expect(
      await readFile(path.join(paths.data, "world", "level.dat"), "utf8"),
    ).toBe("new");
    expect(
      await readFile(path.join(paths.data, "server.properties"), "utf8"),
    ).toBe("motd=keep\n");
    expect(
      (await readdir(paths.data)).filter((name) => name.startsWith(".world-")),
    ).toEqual([]);
    expect(
      (await stat(path.join(paths.data, "world", "level.dat"))).mode & 0o777,
    ).toBe(0o644);
  });

  it("preserves rollback recovery when restoration fails", async () => {
    const { root, paths } = await workspace();
    const activeWorld = path.join(paths.data, "world");
    await mkdir(activeWorld);
    await writeFile(path.join(activeWorld, "level.dat"), "old");
    const archive = path.join(root, "world.zip");
    await makeZip(archive, [{ name: "level.dat", body: "new" }]);
    let renameCalls = 0;

    await expect(
      importWorld(
        "test-server",
        archive,
        paths,
        serverConfig,
        stoppedDocker,
        "world",
        {
          rename: async (source, destination) => {
            renameCalls += 1;
            if (renameCalls >= 2) throw new Error("injected rename failure");
            await rename(source, destination);
          },
          remove: (target, options) => rm(target, options),
        },
      ),
    ).rejects.toThrow(/previous world is preserved at/i);

    const rollback = (await readdir(paths.data)).find((name) =>
      name.startsWith(".world-rollback-"),
    );
    expect(rollback).toBeDefined();
    expect(
      await readFile(path.join(paths.data, rollback!, "level.dat"), "utf8"),
    ).toBe("old");
    await expect(stat(activeWorld)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await readdir(paths.data)).some((name) =>
        name.startsWith(".world-import-"),
      ),
    ).toBe(false);
  });

  it("rechecks stopped state immediately before swapping", async () => {
    const { root, paths } = await workspace();
    await mkdir(path.join(paths.data, "world"));
    await writeFile(path.join(paths.data, "world", "level.dat"), "old");
    const archive = path.join(root, "world.zip");
    await makeZip(archive, [{ name: "level.dat", body: "new" }]);
    let statusCalls = 0;
    const changingDocker = {
      status: async () => ({
        state:
          ++statusCalls === 1 ? ("stopped" as const) : ("running" as const),
        exists: true,
      }),
    } as unknown as ComposeManager;

    await expect(
      importWorld(
        "test-server",
        archive,
        paths,
        serverConfig,
        changingDocker,
        "world",
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(statusCalls).toBe(2);
    expect(
      await readFile(path.join(paths.data, "world", "level.dat"), "utf8"),
    ).toBe("old");
  });

  it("rejects a level-name race and a running server before swapping", async () => {
    const { root, paths } = await workspace();
    await mkdir(path.join(paths.data, "world"));
    await writeFile(path.join(paths.data, "world", "level.dat"), "old");
    const archive = path.join(root, "world.zip");
    await makeZip(archive, [{ name: "level.dat", body: "new" }]);

    await expect(
      importWorld(
        "test-server",
        archive,
        paths,
        serverConfig,
        stoppedDocker,
        "another-world",
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    const runningDocker = {
      status: async () => ({ state: "running" as const, exists: true }),
    } as unknown as ComposeManager;
    await expect(
      importWorld(
        "test-server",
        archive,
        paths,
        serverConfig,
        runningDocker,
        "world",
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      await readFile(path.join(paths.data, "world", "level.dat"), "utf8"),
    ).toBe("old");
  });
});

describe("world info and export", () => {
  it("reports the active world and exports only its contents", async () => {
    const { root, paths } = await workspace();
    await mkdir(path.join(paths.data, "world", "region"), { recursive: true });
    await writeFile(path.join(paths.data, "world", "level.dat"), "level");
    await writeFile(
      path.join(paths.data, "server.properties"),
      "secret=true\n",
    );
    const info = await worldInfo(
      "test-server",
      paths,
      serverConfig,
      stoppedDocker,
    );
    expect(info).toMatchObject({
      levelName: "world",
      exists: true,
      serverState: "stopped",
      canImport: true,
    });
    expect(info.size).toBe(5);

    const archive = path.join(root, "export.zip");
    await createWorldExport(
      "test-server",
      paths,
      serverConfig,
      stoppedDocker,
      archive,
    );
    const inspected = await inspectWorldZip(archive);
    expect(inspected.root).toBe("");
    expect(inspected.entries.map((entry) => entry.normalized)).toContain(
      "level.dat",
    );
    expect(inspected.entries.map((entry) => entry.normalized)).not.toContain(
      "server.properties",
    );
  });

  it("always restores save-on after a running export failure", async () => {
    const { root, paths } = await workspace();
    await mkdir(path.join(paths.data, "world"));
    await writeFile(path.join(paths.data, "world", "level.dat"), "level");
    const calls: string[] = [];
    const docker = {
      status: async () => ({ state: "running" as const, exists: true }),
      console: async (_id: string, _paths: unknown, command: string) => {
        calls.push(command);
        if (command === "save-all flush") throw new Error("flush failed");
        return { stdout: "", stderr: "", code: 0 };
      },
    } as unknown as ComposeManager;

    await expect(
      createWorldExport(
        "test-server",
        paths,
        serverConfig,
        docker,
        path.join(root, "failed.zip"),
      ),
    ).rejects.toThrow("flush failed");
    expect(calls).toEqual(["save-off", "save-all flush", "save-on"]);
  });
});
