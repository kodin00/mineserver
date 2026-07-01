import path from "node:path";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  listServerFiles,
  readServerFile,
  searchServerFiles,
  writeServerFile,
} from "./files.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "mineserver-files-"));
  roots.push(root);
  await mkdir(path.join(root, "config", "example"), { recursive: true });
  await writeFile(
    path.join(root, "config", "example", "settings.toml"),
    "enabled = true\n",
  );
  await writeFile(path.join(root, "server.jar"), Buffer.from([0, 1, 2]));
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("server file access", () => {
  it("lists folders first and marks supported text files editable", async () => {
    const root = await fixture();
    const top = await listServerFiles(root);
    expect(
      top.map((entry) => [entry.name, entry.type, entry.editable]),
    ).toEqual([
      ["config", "directory", false],
      ["server.jar", "file", false],
    ]);
    const nested = await listServerFiles(root, "config/example");
    expect(nested[0]).toMatchObject({
      name: "settings.toml",
      path: "config/example/settings.toml",
      editable: true,
    });
  });

  it("searches recursively and reads and atomically updates UTF-8 files", async () => {
    const root = await fixture();
    const results = await searchServerFiles(root, "settings");
    expect(results.map((entry) => entry.path)).toEqual([
      "config/example/settings.toml",
    ]);

    const before = await readServerFile(
      root,
      "config/example/settings.toml",
      1024,
    );
    const after = await writeServerFile(
      root,
      before.path,
      "enabled = false\n",
      before.modifiedAt,
      1024,
    );
    expect(after.content).toBe("enabled = false\n");
    await expect(
      writeServerFile(
        root,
        before.path,
        "enabled = true\n",
        before.modifiedAt,
        1024,
      ),
    ).rejects.toThrow("changed on disk");
  });

  it("rejects traversal and non-editable binary files", async () => {
    const root = await fixture();
    await symlink(
      path.join(root, "config"),
      path.join(root, "linked-config"),
      "dir",
    );
    await expect(listServerFiles(root, "../")).rejects.toThrow(
      "Invalid file path",
    );
    await expect(listServerFiles(root, "linked-config")).rejects.toThrow(
      "Invalid file path",
    );
    await expect(readServerFile(root, "server.jar", 1024)).rejects.toThrow(
      "cannot be edited",
    );
  });
});
