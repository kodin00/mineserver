import path from "node:path";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { ZipArchive } from "archiver";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import type { BackupFile, BackupSettings } from "@mineserver/shared";
import type { InstancePaths } from "./compose.js";
import type { ComposeManager } from "./docker.js";
import { pathExists, runCommand, safeFilename } from "./utils.js";

const backupPattern = /\.(?:zip|tgz|tar\.gz)$/i;
const activeBackups = new Set<string>();

function backupStamp(date = new Date()): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[:]/g, "-");
}

function openZip(filename: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      filename,
      { lazyEntries: true, autoClose: true },
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
      if (error || !stream)
        reject(error ?? new Error("Unable to read ZIP entry"));
      else resolve(stream);
    });
  });
}

function safeZipEntry(name: string): string {
  const normalized = name.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    segments.some((segment) => segment === "..")
  ) {
    throw new Error(`Unsafe ZIP path: ${name}`);
  }
  return segments.join("/");
}

async function extractZip(filename: string, destination: string) {
  const zip = await openZip(filename);
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      zip.on("error", fail);
      zip.on("end", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          const relative = safeZipEntry(entry.fileName);
          const target = path.join(destination, ...relative.split("/"));
          const relativeTarget = path.relative(destination, target);
          if (
            relativeTarget.startsWith("..") ||
            path.isAbsolute(relativeTarget)
          ) {
            throw new Error(`Unsafe ZIP path: ${entry.fileName}`);
          }
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          if ((mode & 0o170000) === 0o120000) {
            throw new Error("Backup contains a symbolic link");
          }
          if (entry.fileName.endsWith("/")) {
            await mkdir(target, { recursive: true });
          } else {
            await mkdir(path.dirname(target), { recursive: true });
            const stream = await entryStream(zip, entry);
            await pipeline(
              stream,
              createWriteStream(target, { flags: "wx", mode: 0o644 }),
            );
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

export async function createZipFromDirectory(
  source: string,
  destination: string,
) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${crypto.randomUUID()}.partial`;
  const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const completed = new Promise<void>((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.on("warning", (error) => {
      if (error.code !== "ENOENT") reject(error);
    });
  });
  archive.pipe(output);
  archive.directory(source, false, (entry) =>
    entry.type === "symlink" ? false : entry,
  );
  try {
    await Promise.all([archive.finalize(), completed]);
    await rename(temporary, destination);
  } catch (error) {
    archive.abort();
    output.destroy();
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function listBackups(directory: string): Promise<BackupFile[]> {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && backupPattern.test(entry.name))
      .map(async (entry) => {
        const info = await stat(path.join(directory, entry.name));
        return {
          name: entry.name,
          size: info.size,
          createdAt: info.mtime.toISOString(),
        };
      }),
  ).then((files) =>
    files.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );
}

async function pruneBackups(directory: string, settings: BackupSettings) {
  const files = await listBackups(directory);
  const cutoff = Date.now() - settings.retainDays * 24 * 60 * 60_000;
  await Promise.all(
    files
      .filter(
        (file, index) =>
          index >= settings.retainCount ||
          new Date(file.createdAt).getTime() < cutoff,
      )
      .map((file) => rm(path.join(directory, file.name), { force: true })),
  );
}

export async function createBackup(
  id: string,
  paths: InstancePaths,
  docker: ComposeManager,
  settings: BackupSettings,
): Promise<string> {
  if (activeBackups.has(id)) throw new Error("A backup is already running");
  activeBackups.add(id);
  try {
    await mkdir(paths.backups, { recursive: true });
    await docker.console(id, paths, "save-off");
    try {
      await docker.console(id, paths, "save-all flush");
      const filename = `${id}-${backupStamp()}.zip`;
      await createZipFromDirectory(
        paths.data,
        path.join(paths.backups, filename),
      );
      await pruneBackups(paths.backups, settings);
      return filename;
    } finally {
      await docker.console(id, paths, "save-on").catch(() => undefined);
    }
  } finally {
    activeBackups.delete(id);
  }
}

export async function removeBackup(directory: string, filename: string) {
  const safe = safeFilename(filename);
  if (!backupPattern.test(safe)) throw new Error("Invalid backup file");
  const target = path.join(directory, safe);
  if (!(await pathExists(target))) throw new Error("Backup not found");
  await rm(target);
}

export async function restoreBackup(
  id: string,
  filename: string,
  paths: InstancePaths,
  docker: ComposeManager,
) {
  const safe = safeFilename(filename);
  if (!backupPattern.test(safe)) throw new Error("Invalid backup file");
  const backup = path.join(paths.backups, safe);
  if (!(await pathExists(backup))) throw new Error("Backup not found");
  const state = await docker.status(id, paths);
  if (state.state !== "stopped")
    throw new Error("Stop the server before restoring a backup");

  const stamp = backupStamp();
  const safety = path.join(paths.backups, `pre-restore-${stamp}.zip`);
  const staging = path.join(paths.root, `.restore-${crypto.randomUUID()}`);
  const rollback = path.join(paths.root, `.rollback-${stamp}`);
  await mkdir(staging, { recursive: false });

  try {
    await createZipFromDirectory(paths.data, safety);
    if (safe.toLowerCase().endsWith(".zip")) {
      await extractZip(backup, staging);
    } else {
      await runCommand(
        "tar",
        ["-xzf", backup, "-C", staging, "--no-same-owner"],
        { timeoutMs: 60 * 60_000 },
      );
    }
    await docker.down(id, paths).catch(() => undefined);
    await rename(paths.data, rollback);
    await rename(staging, paths.data);
    try {
      await docker.up(id, paths);
      const deadline = Date.now() + 180_000;
      let healthy = false;
      while (Date.now() < deadline) {
        const current = await docker.status(id, paths);
        if (current.state === "running" && current.health !== "starting") {
          healthy = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      if (!healthy) throw new Error("Restored server did not become healthy");
      await rm(rollback, { recursive: true, force: true });
    } catch (error) {
      await docker.down(id, paths).catch(() => undefined);
      await rm(paths.data, { recursive: true, force: true });
      await rename(rollback, paths.data);
      await docker.up(id, paths).catch(() => undefined);
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
