import path from "node:path";
import { createWriteStream } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import type { ServerConfig, ServerState, WorldInfo } from "@mineserver/shared";
import { createZipFromDirectory } from "./backups.js";
import type { InstancePaths } from "./compose.js";
import { config } from "./config.js";
import { resolveLevelName } from "./datapacks.js";
import type { ComposeManager } from "./docker.js";
import { pathExists, resolveWithin } from "./utils.js";

const minecraftUid = 1000;
const minecraftGid = 1000;
const directoryMode = 0o755;
const fileMode = 0o644;
const benignMetadata = new Set([".DS_Store", "Thumbs.db"]);

interface WorldZipEntry {
  entry: Entry;
  normalized: string;
  directory: boolean;
  immutable: {
    fileName: string;
    crc32: number;
    compressedSize: number;
    uncompressedSize: number;
    externalFileAttributes: number;
    generalPurposeBitFlag: number;
    compressionMethod: number;
  };
}

interface InspectedWorldZip {
  root: string;
  entries: WorldZipEntry[];
}

export interface WorldImportFileOperations {
  rename(source: string, destination: string): Promise<void>;
  remove(
    target: string,
    options: { recursive: true; force: true },
  ): Promise<void>;
}

const defaultWorldImportFileOperations: WorldImportFileOperations = {
  rename,
  remove: rm,
};

function openZip(filename: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      filename,
      {
        lazyEntries: true,
        autoClose: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (error, zip) => {
        if (error || !zip) reject(error ?? new Error("Unable to open ZIP"));
        else resolve(zip);
      },
    );
  });
}

function entryStream(
  zip: ZipFile,
  entry: Entry,
): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error("Unable to read ZIP entry"));
      } else {
        resolve(stream);
      }
    });
  });
}

function normalizedZipPath(name: string): string {
  const replaced = name.replace(/\\/g, "/");
  if (
    !replaced ||
    replaced.includes("\0") ||
    replaced.startsWith("/") ||
    /^[A-Za-z]:/.test(replaced)
  ) {
    throw new Error(`Unsafe ZIP path: ${name}`);
  }
  const segments = replaced.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "..")) {
    throw new Error(`Unsafe ZIP path: ${name}`);
  }
  return segments.join("/");
}

function entryKind(entry: Entry): "file" | "directory" {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const unixType = mode & 0o170000;
  if (unixType === 0o120000) {
    throw new Error(`World ZIP contains a symbolic link: ${entry.fileName}`);
  }
  if (unixType && unixType !== 0o100000 && unixType !== 0o040000) {
    throw new Error(`World ZIP contains a special entry: ${entry.fileName}`);
  }
  const directory = entry.fileName.endsWith("/") || unixType === 0o040000;
  if (directory && entry.uncompressedSize !== 0) {
    throw new Error(
      `World ZIP contains an invalid directory: ${entry.fileName}`,
    );
  }
  return directory ? "directory" : "file";
}

function benignPath(normalized: string): boolean {
  const segments = normalized.split("/");
  return (
    segments[0] === "__MACOSX" ||
    segments.some((segment) => benignMetadata.has(segment))
  );
}

function encryptedEntry(entry: Entry): boolean {
  return (entry.generalPurposeBitFlag & 0x1) !== 0;
}

function immutableEntryMetadata(entry: Entry): WorldZipEntry["immutable"] {
  return {
    fileName: entry.fileName,
    crc32: entry.crc32,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
    externalFileAttributes: entry.externalFileAttributes,
    generalPurposeBitFlag: entry.generalPurposeBitFlag,
    compressionMethod: entry.compressionMethod,
  };
}

function sameEntryMetadata(
  entry: Entry,
  expected: WorldZipEntry["immutable"],
): boolean {
  const actual = immutableEntryMetadata(entry);
  return (Object.keys(expected) as Array<keyof typeof expected>).every(
    (key) => actual[key] === expected[key],
  );
}

export async function inspectWorldZip(
  filename: string,
): Promise<InspectedWorldZip> {
  const zip = await openZip(filename);
  const entries: WorldZipEntry[] = [];
  const seen = new Set<string>();
  const files = new Set<string>();
  let fileCount = 0;
  let expandedBytes = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
        zip.close();
      };
      zip.on("error", fail);
      zip.on("end", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      zip.on("entry", (entry: Entry) => {
        try {
          if (encryptedEntry(entry)) {
            throw new Error("Encrypted world ZIPs are not supported");
          }
          const normalized = normalizedZipPath(entry.fileName);
          const key = normalized.toLowerCase();
          if (seen.has(key)) {
            throw new Error(
              `World ZIP contains a duplicate path: ${normalized}`,
            );
          }
          seen.add(key);
          const directory = entryKind(entry) === "directory";
          const segments = key.split("/");
          for (let index = 1; index < segments.length; index += 1) {
            const ancestor = segments.slice(0, index).join("/");
            if (files.has(ancestor)) {
              throw new Error(
                `World ZIP contains a file/directory conflict: ${normalized}`,
              );
            }
          }
          if (!directory) {
            const descendantPrefix = `${key}/`;
            if ([...seen].some((other) => other.startsWith(descendantPrefix))) {
              throw new Error(
                `World ZIP contains a file/directory conflict: ${normalized}`,
              );
            }
            files.add(key);
            fileCount += 1;
            expandedBytes += entry.uncompressedSize;
            if (fileCount > config.MAX_ZIP_FILES) {
              throw new Error(
                `World ZIP contains more than ${config.MAX_ZIP_FILES} files`,
              );
            }
            if (expandedBytes > config.MAX_ZIP_EXPANDED_BYTES) {
              throw new Error("World ZIP expands beyond the configured limit");
            }
          }
          entries.push({
            entry,
            normalized,
            directory,
            immutable: immutableEntryMetadata(entry),
          });
          zip.readEntry();
        } catch (error) {
          fail(error);
        }
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }

  const levelData = entries.filter(
    ({ normalized, directory }) =>
      !directory && path.posix.basename(normalized) === "level.dat",
  );
  if (levelData.length === 0) {
    throw new Error("World ZIP must contain level.dat at its root");
  }
  if (levelData.length > 1) {
    throw new Error("World ZIP contains multiple possible world roots");
  }
  if (levelData[0]!.entry.uncompressedSize === 0) {
    throw new Error("World ZIP contains an empty level.dat");
  }

  const segments = levelData[0]!.normalized.split("/");
  if (segments.length > 2) {
    throw new Error("World ZIP may use at most one wrapper directory");
  }
  const root = segments.length === 1 ? "" : segments[0]!;
  for (const item of entries) {
    if (benignPath(item.normalized)) continue;
    if (!root) continue;
    if (item.normalized === root || item.normalized.startsWith(`${root}/`)) {
      continue;
    }
    throw new Error("World ZIP contains files outside its world directory");
  }
  return { root, entries };
}

async function setMinecraftOwnership(target: string, mode: number) {
  await chmod(target, mode);
  if (process.getuid?.() === 0) {
    await chown(target, minecraftUid, minecraftGid);
  }
}

export async function extractInspectedWorld(
  filename: string,
  inspected: InspectedWorldZip,
  destination: string,
) {
  const byPath = new Map(
    inspected.entries.map((item) => [item.normalized.toLowerCase(), item]),
  );
  const zip = await openZip(filename);
  let expandedBytes = 0;
  let fileCount = 0;
  try {
    await setMinecraftOwnership(destination, directoryMode);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
        zip.close();
      };
      zip.on("error", fail);
      zip.on("end", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          const normalized = normalizedZipPath(entry.fileName);
          const expected = byPath.get(normalized.toLowerCase());
          if (
            !expected ||
            encryptedEntry(entry) ||
            !sameEntryMetadata(entry, expected.immutable) ||
            (entryKind(entry) === "directory") !== expected.directory
          ) {
            throw new Error("World ZIP changed while it was being inspected");
          }
          const withinRoot = inspected.root
            ? normalized.startsWith(`${inspected.root}/`)
              ? normalized.slice(inspected.root.length + 1)
              : ""
            : normalized;
          if (!withinRoot || benignPath(normalized)) {
            zip.readEntry();
            return;
          }
          const target = path.resolve(
            destination,
            ...withinRoot.split("/").filter(Boolean),
          );
          const relative = path.relative(destination, target);
          if (relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new Error(`Unsafe ZIP path: ${entry.fileName}`);
          }
          if (expected.directory) {
            await mkdir(target, { recursive: true });
            await setMinecraftOwnership(target, directoryMode);
          } else {
            fileCount += 1;
            expandedBytes += entry.uncompressedSize;
            if (
              fileCount > config.MAX_ZIP_FILES ||
              expandedBytes > config.MAX_ZIP_EXPANDED_BYTES
            ) {
              throw new Error(
                "World ZIP exceeds the configured extraction limit",
              );
            }
            await mkdir(path.dirname(target), { recursive: true });
            const stream = await entryStream(zip, entry);
            await pipeline(
              stream,
              createWriteStream(target, { flags: "wx", mode: fileMode }),
            );
            await setMinecraftOwnership(target, fileMode);
          }
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

async function directorySummary(directory: string): Promise<{
  size: number;
  modifiedAt: string;
}> {
  let size = 0;
  let modified = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) continue;
      modified = Math.max(modified, info.mtimeMs);
      if (info.isDirectory()) pending.push(target);
      else if (info.isFile()) size += info.size;
    }
  }
  const rootInfo = await stat(directory);
  return {
    size,
    modifiedAt: new Date(Math.max(modified, rootInfo.mtimeMs)).toISOString(),
  };
}

export async function worldInfo(
  id: string,
  paths: InstancePaths,
  serverConfig: ServerConfig,
  docker: ComposeManager,
): Promise<WorldInfo> {
  const [levelName, runtime] = await Promise.all([
    resolveLevelName(paths.data, serverConfig),
    docker.status(id, paths),
  ]);
  const world = resolveWithin(paths.data, levelName);
  let exists = false;
  let size: number | null = null;
  let modifiedAt: string | null = null;
  if (await pathExists(world)) {
    const info = await lstat(world);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("The active world path is not a regular directory");
    }
    exists = true;
    const summary = await directorySummary(world);
    size = summary.size;
    modifiedAt = summary.modifiedAt;
  }
  return {
    levelName,
    exists,
    size,
    modifiedAt,
    serverState: runtime.state,
    canImport: runtime.state === "stopped",
  };
}

export async function createWorldExport(
  id: string,
  paths: InstancePaths,
  serverConfig: ServerConfig,
  docker: ComposeManager,
  destination: string,
): Promise<{ levelName: string; filename: string }> {
  const levelName = await resolveLevelName(paths.data, serverConfig);
  const world = resolveWithin(paths.data, levelName);
  const info = await lstat(world).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw Object.assign(new Error("Active world not found"), {
      statusCode: 404,
    });
  }
  const state = await docker.status(id, paths);
  let savingDisabled = false;
  try {
    if (state.state === "running") {
      await docker.console(id, paths, "save-off");
      savingDisabled = true;
      await docker.console(id, paths, "save-all flush");
    } else if (state.state !== "stopped") {
      throw Object.assign(
        new Error("Wait for the server state to settle before exporting"),
        { statusCode: 409 },
      );
    }
    await createZipFromDirectory(world, destination);
    return { levelName, filename: `${levelName}.zip` };
  } finally {
    if (savingDisabled) {
      await docker.console(id, paths, "save-on").catch(() => undefined);
    }
  }
}

export async function importWorld(
  id: string,
  upload: string,
  paths: InstancePaths,
  serverConfig: ServerConfig,
  docker: ComposeManager,
  acknowledgeLevelName: string,
  fileOperations: WorldImportFileOperations = defaultWorldImportFileOperations,
): Promise<string> {
  const levelName = await resolveLevelName(paths.data, serverConfig);
  if (acknowledgeLevelName !== levelName) {
    throw Object.assign(
      new Error(
        `The active world changed from ${acknowledgeLevelName} to ${levelName}. Review the import again.`,
      ),
      { statusCode: 409 },
    );
  }
  const runtime = await docker.status(id, paths);
  if (runtime.state !== "stopped") {
    throw Object.assign(new Error("Stop the server before importing a world"), {
      statusCode: 409,
    });
  }

  const inspected = await inspectWorldZip(upload);
  const activeWorld = resolveWithin(paths.data, levelName);
  const staging = path.join(paths.data, `.world-import-${crypto.randomUUID()}`);
  const rollback = path.join(
    paths.data,
    `.world-rollback-${crypto.randomUUID()}`,
  );
  let movedCurrent = false;
  let installed = false;
  let rollbackPreserved = false;
  await mkdir(paths.data, { recursive: true });
  await mkdir(staging, { recursive: false, mode: directoryMode });

  try {
    await extractInspectedWorld(upload, inspected, staging);
    const levelData = await stat(path.join(staging, "level.dat")).catch(
      () => null,
    );
    if (!levelData?.isFile() || levelData.size === 0) {
      throw new Error("World ZIP contains no usable level.dat");
    }
    // The panel mutation lease blocks starts and file-manager writes issued by
    // this process. An administrator invoking Docker directly can still race
    // after this final observation; deployments needing stronger isolation
    // must prevent out-of-band container starts while an import is active.
    const beforeSwap = await docker.status(id, paths);
    if (beforeSwap.state !== "stopped") {
      throw Object.assign(
        new Error("The server started while the world was being prepared"),
        { statusCode: 409 },
      );
    }
    if (await pathExists(activeWorld)) {
      const current = await lstat(activeWorld);
      if (!current.isDirectory() || current.isSymbolicLink()) {
        throw new Error("The active world path is not a regular directory");
      }
      await fileOperations.rename(activeWorld, rollback);
      movedCurrent = true;
    }
    await fileOperations.rename(staging, activeWorld);
    installed = true;
    await fileOperations.remove(rollback, { recursive: true, force: true });
    movedCurrent = false;
    return `Imported world ${levelName}. The server remains stopped.`;
  } catch (error) {
    try {
      if (installed) {
        await fileOperations.remove(activeWorld, {
          recursive: true,
          force: true,
        });
        installed = false;
      }
      if (movedCurrent && (await pathExists(rollback))) {
        await fileOperations.rename(rollback, activeWorld);
        movedCurrent = false;
      }
    } catch (recoveryError) {
      rollbackPreserved = movedCurrent && (await pathExists(rollback));
      const recoveryMessage =
        recoveryError instanceof Error
          ? recoveryError.message
          : String(recoveryError);
      throw new Error(
        rollbackPreserved
          ? `World import failed and automatic recovery failed: ${recoveryMessage}. The previous world is preserved at ${rollback}`
          : `World import failed and automatic recovery failed: ${recoveryMessage}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    await fileOperations.remove(staging, { recursive: true, force: true });
    if (!rollbackPreserved && !movedCurrent) {
      await fileOperations.remove(rollback, { recursive: true, force: true });
    }
  }
}

export function worldStateCanExport(state: ServerState): boolean {
  return state === "running" || state === "stopped";
}
