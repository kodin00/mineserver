import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createZipFromDirectory, listBackups } from "./backups.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ZIP backups", () => {
  it("creates ZIP archives and lists legacy archives during migration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mineserver-backups-"));
    roots.push(root);
    const data = path.join(root, "data");
    const backups = path.join(root, "backups");
    await mkdir(path.join(data, "world"), { recursive: true });
    await mkdir(backups);
    await writeFile(path.join(data, "world", "level.dat"), "world data");

    const zip = path.join(backups, "server-2026-07-01.zip");
    await createZipFromDirectory(data, zip);
    await writeFile(path.join(backups, "legacy.tgz"), "legacy");

    expect((await readFile(zip)).subarray(0, 2).toString()).toBe("PK");
    expect(
      (await listBackups(backups)).map((file) => file.name).sort(),
    ).toEqual(["legacy.tgz", "server-2026-07-01.zip"]);
  });
});
