import path from "node:path";
import { createReadStream, type ReadStream } from "node:fs";
import {
  copyFile,
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { ServerFileDocument, ServerFileEntry } from "@mineserver/shared";

const editableExtensions = new Set([
  ".cfg",
  ".conf",
  ".hocon",
  ".ini",
  ".json",
  ".json5",
  ".lang",
  ".list",
  ".log",
  ".md",
  ".properties",
  ".toml",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const maxPathLength = 1024;
const maxNameLength = 255;
const minecraftUid = 1000;
const minecraftGid = 1000;
const fileMode = 0o644;
const directoryMode = 0o755;

function httpError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}

export function normalizeRelativePath(input = ""): string {
  if (
    input.includes("\0") ||
    path.isAbsolute(input) ||
    Buffer.byteLength(input, "utf8") > maxPathLength
  ) {
    throw new Error("Invalid file path");
  }
  const normalized = input.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Invalid file path");
  }
  return segments.join("/");
}

function validateLeafName(input: string): string {
  if (
    !input ||
    input === "." ||
    input === ".." ||
    input.includes("/") ||
    input.includes("\\") ||
    /[\0-\x1f\x7f]/.test(input) ||
    Buffer.byteLength(input, "utf8") > maxNameLength
  ) {
    throw new Error("Invalid file name");
  }
  return input;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export async function resolveExisting(root: string, input = "") {
  await mkdir(root, { recursive: true });
  const relative = normalizeRelativePath(input);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink()) throw new Error("Invalid file path");
  const resolvedRoot = await realpath(root);
  let cursor = resolvedRoot;
  try {
    for (const segment of relative.split("/").filter(Boolean)) {
      cursor = path.join(cursor, segment);
      if ((await lstat(cursor)).isSymbolicLink()) {
        throw new Error("Invalid file path");
      }
    }
    const resolvedTarget = await realpath(cursor);
    if (!isInside(resolvedRoot, resolvedTarget)) {
      throw new Error("Invalid file path");
    }
    return { root: resolvedRoot, relative, target: resolvedTarget };
  } catch (error: any) {
    if (error?.code === "ENOENT") throw httpError("File not found", 404);
    throw error;
  }
}

async function resolveNewLeaf(root: string, input: string) {
  const relative = normalizeRelativePath(input);
  if (!relative) throw new Error("The server data root cannot be changed");
  const segments = relative.split("/");
  const leaf = validateLeafName(segments.pop()!);
  const parentRelative = segments.join("/");
  const parent = await resolveExisting(root, parentRelative);
  const parentInfo = await stat(parent.target);
  if (!parentInfo.isDirectory()) throw httpError("Folder not found", 404);
  const target = path.join(parent.target, leaf);
  if (!isInside(parent.root, target)) throw new Error("Invalid file path");
  try {
    await lstat(target);
    throw httpError("A file or folder with that name already exists", 409);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { relative, parent: parent.target, target, leaf };
}

async function ensureMinecraftOwned(target: string, mode: number) {
  await chmod(target, mode);
  if (process.getuid?.() === 0) {
    await chown(target, minecraftUid, minecraftGid).catch(() => undefined);
  }
}

export function isEditableFilename(filename: string): boolean {
  return editableExtensions.has(path.extname(filename).toLowerCase());
}

function entryPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

async function describeEntry(
  relative: string,
  target: string,
): Promise<ServerFileEntry> {
  const info = await stat(target);
  const name = path.basename(relative);
  const isDirectory = info.isDirectory();
  if (!isDirectory && !info.isFile()) throw new Error("Unsupported file type");
  return {
    name,
    path: relative,
    type: isDirectory ? "directory" : "file",
    size: isDirectory ? null : info.size,
    modifiedAt: info.mtime.toISOString(),
    editable: !isDirectory && isEditableFilename(name),
  };
}

export async function listServerFiles(
  root: string,
  requestedPath = "",
): Promise<ServerFileEntry[]> {
  const { relative, target } = await resolveExisting(root, requestedPath);
  const targetInfo = await stat(target);
  if (!targetInfo.isDirectory()) throw httpError("Folder not found", 404);
  const entries = await readdir(target, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter(
        (entry) =>
          (entry.isDirectory() || entry.isFile()) && !entry.isSymbolicLink(),
      )
      .map((entry) =>
        describeEntry(
          entryPath(relative, entry.name),
          path.join(target, entry.name),
        ),
      ),
  );
  return files.sort(
    (a, b) =>
      Number(b.type === "directory") - Number(a.type === "directory") ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

export async function searchServerFiles(
  root: string,
  query: string,
  limit = 100,
): Promise<ServerFileEntry[]> {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  await mkdir(root, { recursive: true });
  const { target: resolvedRoot } = await resolveExisting(root);
  const results: ServerFileEntry[] = [];
  const pending: Array<{ absolute: string; relative: string }> = [
    { absolute: resolvedRoot, relative: "" },
  ];

  while (pending.length && results.length < limit) {
    const current = pending.shift()!;
    const entries = await readdir(current.absolute, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relative = entryPath(current.relative, entry.name);
      const absolute = path.join(current.absolute, entry.name);
      if (entry.isDirectory()) pending.push({ absolute, relative });
      if (
        (entry.isFile() || entry.isDirectory()) &&
        (entry.name.toLocaleLowerCase().includes(needle) ||
          relative.toLocaleLowerCase().includes(needle))
      ) {
        results.push(await describeEntry(relative, absolute));
        if (results.length >= limit) break;
      }
    }
  }
  return results.sort((a, b) =>
    a.path.localeCompare(b.path, undefined, { sensitivity: "base" }),
  );
}

export async function readServerFile(
  root: string,
  requestedPath: string,
  maxBytes: number,
): Promise<ServerFileDocument> {
  const { relative, target } = await resolveExisting(root, requestedPath);
  const info = await stat(target);
  if (!info.isFile()) throw httpError("File not found", 404);
  if (!isEditableFilename(relative)) {
    throw new Error("This file type cannot be edited");
  }
  if (info.size > maxBytes) {
    throw new Error("File is too large to edit in the browser");
  }
  const buffer = await readFile(target);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error("File is not valid UTF-8 text");
  }
  if (content.includes("\0")) throw new Error("Binary files cannot be edited");
  return {
    path: relative,
    content,
    size: buffer.length,
    modifiedAt: info.mtime.toISOString(),
  };
}

export async function writeServerFile(
  root: string,
  requestedPath: string,
  content: string,
  expectedModifiedAt: string | undefined,
  maxBytes: number,
): Promise<ServerFileDocument> {
  const { relative, target } = await resolveExisting(root, requestedPath);
  const info = await stat(target);
  if (!info.isFile()) throw httpError("File not found", 404);
  if (!isEditableFilename(relative)) {
    throw new Error("This file type cannot be edited");
  }
  if (expectedModifiedAt && info.mtime.toISOString() !== expectedModifiedAt) {
    throw httpError("File changed on disk. Reload it before saving.", 409);
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxBytes) {
    throw new Error("File is too large to edit in the browser");
  }

  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, content, { flag: "wx", mode: info.mode });
    await chmod(temporary, info.mode);
    if (process.getuid?.() === 0) await chown(temporary, info.uid, info.gid);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return readServerFile(root, relative, maxBytes);
}

export async function createServerFileEntry(
  root: string,
  parentPath: string,
  name: string,
  type: "file" | "directory",
): Promise<ServerFileEntry> {
  const parent = normalizeRelativePath(parentPath);
  const leaf = validateLeafName(name.trim());
  const destination = await resolveNewLeaf(root, entryPath(parent, leaf));
  if (type === "directory") {
    await mkdir(destination.target, { recursive: false, mode: directoryMode });
    await ensureMinecraftOwned(destination.target, directoryMode);
  } else {
    const handle = await open(destination.target, "wx", fileMode);
    await handle.close();
    await ensureMinecraftOwned(destination.target, fileMode);
  }
  return describeEntry(destination.relative, destination.target);
}

export async function installServerFileUploads(
  root: string,
  parentPath: string,
  uploads: Array<{ path: string; originalName: string }>,
): Promise<ServerFileEntry[]> {
  const parent = normalizeRelativePath(parentPath);
  const leaves = uploads.map((upload) => ({
    upload,
    leaf: validateLeafName(upload.originalName),
  }));
  const duplicate = leaves.find(
    (item, index) =>
      leaves.findIndex(
        (other) =>
          other.leaf.toLocaleLowerCase() === item.leaf.toLocaleLowerCase(),
      ) !== index,
  );
  if (duplicate) throw httpError(`Duplicate upload: ${duplicate.leaf}`, 409);

  const existing = await listServerFiles(root, parent);
  const existingNames = new Set(
    existing.map((entry) => entry.name.toLocaleLowerCase()),
  );
  const colliding = leaves.find((item) =>
    existingNames.has(item.leaf.toLocaleLowerCase()),
  );
  if (colliding) {
    throw httpError(
      `A file or folder named ${colliding.leaf} already exists`,
      409,
    );
  }

  const destinations = await Promise.all(
    leaves.map(async ({ upload, leaf }) => ({
      upload,
      destination: await resolveNewLeaf(root, entryPath(parent, leaf)),
    })),
  );
  const reservations = new Map<string, { committed: boolean }>();
  const committed: typeof destinations = [];
  try {
    for (const item of destinations) {
      reservations.set(item.destination.target, { committed: false });
    }
    for (const item of destinations) {
      const reservation = reservations.get(item.destination.target)!;
      try {
        // Streamed copy: uploads can be up to MAX_UPLOAD_BYTES (2 GiB), so
        // never buffer the whole file in memory.
        await copyFile(item.upload.path, item.destination.target);
        reservation.committed = true;
        committed.push(item);
      } finally {
        if (reservation.committed) reservations.delete(item.destination.target);
      }
      await rm(item.upload.path);
      await ensureMinecraftOwned(item.destination.target, fileMode);
    }
  } catch (error) {
    await Promise.all(
      [...reservations.keys()].map(async (target) => {
        await rm(target, { force: true });
      }),
    );
    await Promise.all(
      committed.map((item) => rm(item.destination.target, { force: true })),
    );
    throw error;
  }
  return Promise.all(
    destinations.map((item) =>
      describeEntry(item.destination.relative, item.destination.target),
    ),
  );
}

export async function serverFileDownload(
  root: string,
  requestedPath: string,
): Promise<{ filename: string; size: number; stream: ReadStream }> {
  const { relative, target } = await resolveExisting(root, requestedPath);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("Only files can be downloaded");
  return {
    filename: path.basename(relative),
    size: info.size,
    stream: createReadStream(target),
  };
}

export async function moveServerFileEntry(
  root: string,
  sourcePath: string,
  destinationPath: string,
): Promise<ServerFileEntry> {
  const source = await resolveExisting(root, sourcePath);
  if (!source.relative) throw new Error("The server data root cannot be moved");
  const destinationRelative = normalizeRelativePath(destinationPath);
  if (!destinationRelative) throw new Error("Invalid destination path");
  if (source.relative === destinationRelative) {
    throw httpError("Source and destination are the same", 409);
  }
  const sourceInfo = await stat(source.target);
  if (!sourceInfo.isFile() && !sourceInfo.isDirectory()) {
    throw new Error("Unsupported file type");
  }
  if (
    sourceInfo.isDirectory() &&
    destinationRelative.startsWith(`${source.relative}/`)
  ) {
    throw new Error("A folder cannot be moved into itself");
  }
  const destination = await resolveNewLeaf(root, destinationRelative);
  await rename(source.target, destination.target);
  return describeEntry(destination.relative, destination.target);
}

export async function deleteServerFileEntry(
  root: string,
  requestedPath: string,
  expectedModifiedAt?: string,
): Promise<void> {
  const resolved = await resolveExisting(root, requestedPath);
  if (!resolved.relative)
    throw new Error("The server data root cannot be deleted");
  const info = await stat(resolved.target);
  if (!info.isFile() && !info.isDirectory())
    throw new Error("Unsupported file type");
  if (expectedModifiedAt && info.mtime.toISOString() !== expectedModifiedAt) {
    throw httpError(
      "File or folder changed on disk. Refresh and try again.",
      409,
    );
  }
  await rm(resolved.target, { recursive: info.isDirectory(), force: false });
}
