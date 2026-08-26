import path from "node:path";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createServerFileEntry,
  deleteServerFileEntry,
  installServerFileUploads,
  listServerFiles,
  moveServerFileEntry,
  readServerFile,
  searchServerFiles,
  serverFileDownload,
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

async function tempUpload(root: string, name: string, contents: string) {
  const uploadPath = path.join(root, `.upload-${name}`);
  await writeFile(uploadPath, contents);
  return { path: uploadPath, originalName: name };
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

  it("creates files and folders without overwriting existing entries", async () => {
    const root = await fixture();
    const folder = await createServerFileEntry(
      root,
      "config",
      "new folder",
      "directory",
    );
    const file = await createServerFileEntry(
      root,
      folder.path,
      "notes.txt",
      "file",
    );

    expect(folder).toMatchObject({
      path: "config/new folder",
      type: "directory",
    });
    expect(file).toMatchObject({
      path: "config/new folder/notes.txt",
      type: "file",
      size: 0,
      editable: true,
    });
    expect((await stat(path.join(root, file.path))).mode & 0o777).toBe(0o644);
    expect((await stat(path.join(root, folder.path))).mode & 0o777).toBe(0o755);
    await expect(
      createServerFileEntry(root, folder.path, "notes.txt", "file"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("installs staged uploads and rolls back every committed file on a later failure", async () => {
    const root = await fixture();
    const first = await tempUpload(root, "alpha.bin", "alpha");
    const second = await tempUpload(root, "beta.bin", "beta");
    const installed = await installServerFileUploads(root, "config", [
      first,
      second,
    ]);
    expect(installed.map((entry) => entry.path)).toEqual([
      "config/alpha.bin",
      "config/beta.bin",
    ]);
    expect(await readFile(path.join(root, "config", "alpha.bin"), "utf8")).toBe(
      "alpha",
    );

    const duplicateA = await tempUpload(root, "same-a", "one");
    const duplicateB = await tempUpload(root, "same-b", "two");
    await expect(
      installServerFileUploads(root, "config", [
        { ...duplicateA, originalName: "same.txt" },
        { ...duplicateB, originalName: "same.txt" },
      ]),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      stat(path.join(root, "config", "same.txt")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    const rollbackA = await tempUpload(root, "rollback-a", "one");
    const rollbackB = await tempUpload(root, "rollback-b", "two");
    await rm(rollbackB.path);
    await expect(
      installServerFileUploads(root, "config", [
        { ...rollbackA, originalName: "first.txt" },
        { ...rollbackB, originalName: "second.txt" },
      ]),
    ).rejects.toThrow();
    await expect(
      stat(path.join(root, "config", "first.txt")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("streams binary files for download", async () => {
    const root = await fixture();
    const download = await serverFileDownload(root, "server.jar");
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream) chunks.push(Buffer.from(chunk));
    expect(download).toMatchObject({ filename: "server.jar", size: 3 });
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 1, 2]));
    await expect(serverFileDownload(root, "config")).rejects.toThrow(
      "Only files can be downloaded",
    );
  });

  it("renames and moves regular entries without overwriting or self-nesting", async () => {
    const root = await fixture();
    const renamed = await moveServerFileEntry(
      root,
      "config/example/settings.toml",
      "config/example/renamed.toml",
    );
    expect(renamed.path).toBe("config/example/renamed.toml");
    await expect(
      moveServerFileEntry(root, "server.jar", "config"),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      moveServerFileEntry(root, "config", "config/example/config"),
    ).rejects.toThrow("cannot be moved into itself");
    await expect(moveServerFileEntry(root, "", "root-copy")).rejects.toThrow(
      "root cannot be moved",
    );
  });

  it("recursively deletes entries with optimistic modification checks but not root", async () => {
    const root = await fixture();
    const folderInfo = await stat(path.join(root, "config"));
    await expect(
      deleteServerFileEntry(root, "config", new Date(0).toISOString()),
    ).rejects.toMatchObject({ statusCode: 409 });
    await deleteServerFileEntry(root, "config", folderInfo.mtime.toISOString());
    await expect(stat(path.join(root, "config"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(deleteServerFileEntry(root, "")).rejects.toThrow(
      "root cannot be deleted",
    );
  });

  it("rejects traversal, symlink paths, invalid leaves, and non-editable binary files", async () => {
    const root = await fixture();
    const outside = await mkdtemp(
      path.join(tmpdir(), "mineserver-files-outside-"),
    );
    roots.push(outside);
    await symlink(
      path.join(root, "config"),
      path.join(root, "linked-config"),
      "dir",
    );
    await symlink(outside, path.join(root, "outside"), "dir");
    await expect(listServerFiles(root, "../")).rejects.toThrow(
      "Invalid file path",
    );
    await expect(listServerFiles(root, "linked-config")).rejects.toThrow(
      "Invalid file path",
    );
    await expect(
      createServerFileEntry(root, "outside", "escape.txt", "file"),
    ).rejects.toThrow("Invalid file path");
    await expect(
      createServerFileEntry(root, "config", "../escape", "file"),
    ).rejects.toThrow("Invalid file name");
    await expect(readServerFile(root, "server.jar", 1024)).rejects.toThrow(
      "cannot be edited",
    );
  });
});
