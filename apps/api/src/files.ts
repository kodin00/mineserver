import path from "node:path";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
  chmod,
  chown,
  rm,
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

function normalizeRelativePath(input = ""): string {
  if (input.includes("\0") || path.isAbsolute(input)) {
    throw new Error("Invalid file path");
  }
  const normalized = input.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Invalid file path");
  }
  return segments.join("/");
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function resolveExisting(root: string, input = "") {
  await mkdir(root, { recursive: true });
  const relative = normalizeRelativePath(input);
  const lexical = path.join(root, ...relative.split("/").filter(Boolean));
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink()) throw new Error("Invalid file path");
  const resolvedRoot = await realpath(root);
  let cursor = resolvedRoot;
  for (const segment of relative.split("/").filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if ((await lstat(cursor)).isSymbolicLink()) {
      throw new Error("Invalid file path");
    }
  }
  const resolvedTarget = await realpath(lexical);
  if (!isInside(resolvedRoot, resolvedTarget)) {
    throw new Error("Invalid file path");
  }
  return { relative, target: resolvedTarget };
}

export function isEditableFilename(filename: string): boolean {
  return editableExtensions.has(path.extname(filename).toLowerCase());
}

function entryPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export async function listServerFiles(
  root: string,
  requestedPath = "",
): Promise<ServerFileEntry[]> {
  const { relative, target } = await resolveExisting(root, requestedPath);
  const targetInfo = await stat(target);
  if (!targetInfo.isDirectory()) throw new Error("Folder not found");
  const entries = await readdir(target, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter(
        (entry) =>
          (entry.isDirectory() || entry.isFile()) && !entry.isSymbolicLink(),
      )
      .map(async (entry): Promise<ServerFileEntry> => {
        const info = await stat(path.join(target, entry.name));
        const isDirectory = entry.isDirectory();
        return {
          name: entry.name,
          path: entryPath(relative, entry.name),
          type: isDirectory ? "directory" : "file",
          size: isDirectory ? null : info.size,
          modifiedAt: info.mtime.toISOString(),
          editable: !isDirectory && isEditableFilename(entry.name),
        };
      }),
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
  const resolvedRoot = await realpath(root);
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
      if (entry.isDirectory()) {
        pending.push({ absolute, relative });
      }
      if (
        (entry.isFile() || entry.isDirectory()) &&
        (entry.name.toLocaleLowerCase().includes(needle) ||
          relative.toLocaleLowerCase().includes(needle))
      ) {
        const info = await stat(absolute);
        results.push({
          name: entry.name,
          path: relative,
          type: entry.isDirectory() ? "directory" : "file",
          size: entry.isFile() ? info.size : null,
          modifiedAt: info.mtime.toISOString(),
          editable: entry.isFile() && isEditableFilename(entry.name),
        });
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
  if (!info.isFile()) throw new Error("File not found");
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
  if (!info.isFile()) throw new Error("File not found");
  if (!isEditableFilename(relative)) {
    throw new Error("This file type cannot be edited");
  }
  if (expectedModifiedAt && info.mtime.toISOString() !== expectedModifiedAt) {
    throw Object.assign(
      new Error("File changed on disk. Reload it before saving."),
      { statusCode: 409 },
    );
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
