import path from "node:path";
import {
  chmod,
  chown,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import type { ServerConfig } from "@mineserver/shared";
import { config } from "./config.js";
import { pathExists, resolveWithin, safeFilename } from "./utils.js";

// The Minecraft container runs as uid 1000, so anything the panel writes into
// the data volume has to be readable by it or the server silently ignores it.
const minecraftUid = 1000;
const minecraftGid = 1000;
const containerReadableMode = 0o644;
const containerTraversableMode = 0o755;

const defaultLevelName = "world";
const levelNamePattern = /^[A-Za-z0-9._][A-Za-z0-9._ -]{0,63}$/;

function validateLevelName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return null;
  return levelNamePattern.test(trimmed) ? trimmed : null;
}

/**
 * server.properties is editable through the panel's file editor, so a hostile
 * level-name must never become part of a write path. Anything that fails
 * validation is ignored rather than trusted.
 */
export function parseLevelNameFromProperties(contents: string): string | null {
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!"))
      continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    if (trimmed.slice(0, separator).trim() !== "level-name") continue;
    return validateLevelName(trimmed.slice(separator + 1));
  }
  return null;
}

/**
 * Pending panel config wins over what is on disk, because a datapack should
 * land in the world the server will load next. The resolved name is always
 * reported back to the caller so the UI can state which world was used.
 */
export async function resolveLevelName(
  dataDir: string,
  serverConfig: ServerConfig,
): Promise<string> {
  const fromProperties = serverConfig.customProperties["level-name"];
  if (fromProperties) {
    const valid = validateLevelName(fromProperties);
    if (valid) return valid;
  }
  const fromEnv = serverConfig.advancedEnv.LEVEL;
  if (fromEnv) {
    const valid = validateLevelName(fromEnv);
    if (valid) return valid;
  }
  const propertiesPath = path.join(dataDir, "server.properties");
  if (await pathExists(propertiesPath)) {
    const contents = await readFile(propertiesPath, "utf8").catch(() => "");
    const parsed = parseLevelNameFromProperties(contents);
    if (parsed) return parsed;
  }
  return defaultLevelName;
}

export function datapacksDirectory(dataDir: string, levelName: string): string {
  return resolveWithin(dataDir, levelName, "datapacks");
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

/**
 * Reads the central directory only. A datapack has to stay a zip, so nothing is
 * extracted; this just proves it looks like a datapack and is not a zip bomb.
 */
async function inspectDatapackZip(tempPath: string) {
  const zip = await openZip(tempPath);
  let entries = 0;
  let expanded = 0;
  let hasManifest = false;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: Entry) => {
        const normalized = entry.fileName.replace(/\\/g, "/");
        if (!normalized.endsWith("/")) {
          entries += 1;
          expanded += entry.uncompressedSize;
          if (entries > config.MODRINTH_MAX_DATAPACK_FILES) {
            reject(
              new Error(
                `Datapack contains more than ${config.MODRINTH_MAX_DATAPACK_FILES} files`,
              ),
            );
            return;
          }
          if (expanded > config.MAX_ZIP_EXPANDED_BYTES) {
            reject(new Error("Datapack expands beyond the configured limit"));
            return;
          }
          // Minecraft accepts pack.mcmeta at the root; some packs nest it one
          // level down inside a wrapper directory.
          const segments = normalized.split("/");
          if (segments[segments.length - 1] === "pack.mcmeta")
            hasManifest = true;
        }
        zip.readEntry();
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  if (!hasManifest) {
    throw new Error("That file does not look like a datapack (no pack.mcmeta)");
  }
}

export interface DatapackInstallResult {
  filename: string;
  levelName: string;
  worldCreated: boolean;
}

export async function installDatapack(
  tempPath: string,
  originalName: string,
  dataDir: string,
  levelName: string,
): Promise<DatapackInstallResult> {
  const filename = safeFilename(path.basename(originalName));
  if (!filename.toLowerCase().endsWith(".zip")) {
    throw new Error(
      "Only .zip datapacks are accepted. If this project ships as a mod, install it under add-ons instead.",
    );
  }
  await inspectDatapackZip(tempPath);

  const worldDir = resolveWithin(dataDir, levelName);
  // A world directory that does not exist yet is normal for a server that has
  // never started. Datapacks present at world creation are enabled by default,
  // so creating it is better behaviour than refusing.
  const worldCreated = !(await pathExists(worldDir));
  const directory = datapacksDirectory(dataDir, levelName);
  await mkdir(directory, { recursive: true });

  const target = path.join(directory, filename);
  if (await pathExists(target)) {
    throw new Error(`A datapack named ${filename} already exists`);
  }
  await rename(tempPath, target);
  try {
    await chmod(target, containerReadableMode);
    await ensureMinecraftOwned(target);
    if (worldCreated) {
      await ensureMinecraftOwned(worldDir, containerTraversableMode);
    }
    await ensureMinecraftOwned(directory, containerTraversableMode);
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }
  return { filename, levelName, worldCreated };
}

async function ensureMinecraftOwned(pathname: string, mode?: number) {
  if (mode !== undefined) await chmod(pathname, mode);
  if (process.getuid?.() !== 0) return;
  // Best effort only. Some bind mounts (Docker Desktop on macOS, for one)
  // ignore or reject chown, and the mode above is already enough for the game
  // container to read the file. Failing the install here would throw away a
  // perfectly good download.
  await chown(pathname, minecraftUid, minecraftGid).catch(() => undefined);
}

export interface DatapackFile {
  name: string;
  size: number;
  modifiedAt: string;
}

export async function listDatapacks(
  dataDir: string,
  levelName: string,
): Promise<DatapackFile[]> {
  const directory = datapacksDirectory(dataDir, levelName);
  if (!(await pathExists(directory))) return [];
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && /\.zip$/i.test(entry.name))
      .map(async (entry) => {
        const info = await stat(path.join(directory, entry.name));
        return {
          name: entry.name,
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        };
      }),
  );
  return files.sort((a, b) => a.name.localeCompare(b.name));
}
