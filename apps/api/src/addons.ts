import path from "node:path";
import { createWriteStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { ZipArchive } from "archiver";
import type { AddonFile } from "@mineserver/shared";
import { config } from "./config.js";
import { pathExists, safeFilename } from "./utils.js";

export async function listAddons(directory: string): Promise<AddonFile[]> {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(
    entries
      .filter(
        (entry) => entry.isFile() && /\.jar(?:\.disabled)?$/i.test(entry.name),
      )
      .map(async (entry) => {
        const info = await stat(path.join(directory, entry.name));
        return {
          name: entry.name.replace(/\.disabled$/i, ""),
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
          enabled: !entry.name.endsWith(".disabled"),
        };
      }),
  ).then((files) => files.sort((a, b) => a.name.localeCompare(b.name)));
}

export async function installJar(
  tempPath: string,
  originalName: string,
  directory: string,
) {
  const filename = safeFilename(path.basename(originalName));
  if (!filename.toLowerCase().endsWith(".jar"))
    throw new Error("Only .jar files are accepted");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, filename);
  if ((await pathExists(target)) || (await pathExists(`${target}.disabled`))) {
    throw new Error(`An add-on named ${filename} already exists`);
  }
  await rename(tempPath, target);
  return filename;
}

export async function installAddonBatch(
  uploads: Array<{ path: string; originalName: string }>,
  directory: string,
): Promise<string[]> {
  const installed: string[] = [];
  try {
    for (const upload of uploads) {
      const extension = path.extname(upload.originalName).toLowerCase();
      const names =
        extension === ".jar"
          ? [await installJar(upload.path, upload.originalName, directory)]
          : await installZip(upload.path, directory);
      installed.push(...names);
    }
    return installed;
  } catch (error) {
    await Promise.all(
      installed.map((filename) =>
        removeAddon(directory, filename).catch(() => undefined),
      ),
    );
    throw error;
  }
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

export async function installZip(
  tempPath: string,
  directory: string,
): Promise<string[]> {
  await mkdir(directory, { recursive: true });
  const staging = path.join(directory, `.staging-${crypto.randomUUID()}`);
  await mkdir(staging, { recursive: false });
  const extracted: string[] = [];
  let expanded = 0;
  let count = 0;
  const zip = await openZip(tempPath);

  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: Entry) => {
        void (async () => {
          const normalized = entry.fileName.replace(/\\/g, "/");
          const segments = normalized.split("/");
          if (
            normalized.startsWith("/") ||
            segments.includes("..") ||
            /^[A-Za-z]:/.test(normalized)
          ) {
            throw new Error(`Unsafe ZIP path: ${entry.fileName}`);
          }
          if (normalized.endsWith("/")) {
            zip.readEntry();
            return;
          }
          const leaf = safeFilename(path.posix.basename(normalized));
          if (normalized.startsWith("__MACOSX/") || leaf === ".DS_Store") {
            zip.readEntry();
            return;
          }
          if (!leaf.toLowerCase().endsWith(".jar")) {
            throw new Error(`ZIP contains a non-JAR file: ${entry.fileName}`);
          }
          count += 1;
          expanded += entry.uncompressedSize;
          if (count > config.MAX_ZIP_FILES)
            throw new Error("ZIP contains too many files");
          if (expanded > config.MAX_ZIP_EXPANDED_BYTES)
            throw new Error("ZIP expands beyond the configured limit");
          if (
            extracted.some((name) => name.toLowerCase() === leaf.toLowerCase())
          ) {
            throw new Error(`ZIP contains duplicate filename: ${leaf}`);
          }
          if (
            (await pathExists(path.join(directory, leaf))) ||
            (await pathExists(path.join(directory, `${leaf}.disabled`)))
          ) {
            throw new Error(`An add-on named ${leaf} already exists`);
          }
          const stream = await entryStream(zip, entry);
          const target = path.join(staging, leaf);
          await pipeline(
            stream,
            createWriteStream(target, { flags: "wx", mode: 0o644 }),
          );
          extracted.push(leaf);
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });

    if (extracted.length === 0) throw new Error("ZIP contains no JAR files");
    const moved: string[] = [];
    try {
      for (const filename of extracted) {
        await rename(
          path.join(staging, filename),
          path.join(directory, filename),
        );
        moved.push(filename);
      }
    } catch (error) {
      await Promise.all(
        moved.map((filename) =>
          rm(path.join(directory, filename), { force: true }),
        ),
      );
      throw error;
    }
    return extracted;
  } finally {
    zip.close();
    await rm(staging, { recursive: true, force: true });
  }
}

export async function removeAddon(directory: string, filename: string) {
  const safe = safeFilename(filename);
  const enabled = path.join(directory, safe);
  const disabled = path.join(directory, `${safe}.disabled`);
  if (await pathExists(enabled)) await rm(enabled);
  else if (await pathExists(disabled)) await rm(disabled);
  else throw new Error("Add-on not found");
}

export async function setAddonEnabled(
  directory: string,
  filename: string,
  enabled: boolean,
) {
  const safe = safeFilename(filename);
  const from = path.join(directory, enabled ? `${safe}.disabled` : safe);
  const to = path.join(directory, enabled ? safe : `${safe}.disabled`);
  if (!(await pathExists(from)))
    throw new Error("Add-on not found or already in requested state");
  await rename(from, to);
}

export async function addonFilePath(
  directory: string,
  filename: string,
): Promise<string> {
  const safe = safeFilename(filename);
  if (!safe.toLowerCase().endsWith(".jar"))
    throw new Error("Invalid add-on file");
  const enabled = path.join(directory, safe);
  const disabled = path.join(directory, `${safe}.disabled`);
  if (await pathExists(enabled)) return enabled;
  if (await pathExists(disabled)) return disabled;
  throw new Error("Add-on not found");
}

export async function createAddonsArchive(directory: string) {
  const files = await listAddons(directory);
  if (files.length === 0) throw new Error("No add-ons to download");
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on("warning", (error) => {
    if (error.code !== "ENOENT") archive.destroy(error);
  });
  for (const file of files) {
    archive.file(await addonFilePath(directory, file.name), {
      name: file.name,
    });
  }
  void archive.finalize().catch((error) => archive.destroy(error));
  return archive;
}

export async function createTempUpload(tempRoot: string): Promise<{
  path: string;
  stream: NodeJS.WritableStream;
}> {
  await mkdir(tempRoot, { recursive: true });
  const filename = path.join(tempRoot, crypto.randomUUID());
  const handle = await open(filename, "wx", 0o600);
  return { path: filename, stream: handle.createWriteStream() };
}
