import path from "node:path";
import { rm, rmdir } from "node:fs/promises";
import {
  marketplaceTargetFor,
  type MarketplaceProjectType,
  type MarketplaceTarget,
  type ModrinthInstallPreview,
  type ModrinthPreviewEntry,
  type ModrinthVersionFile,
  type ModrinthVersionSummary,
  type ServerConfig,
} from "@mineserver/shared";
import type { InstancePaths } from "./compose.js";
import type { AddonSourceRow, Store } from "./db.js";
import type { ExpectedFile, ModrinthApi } from "./modrinth.js";
import { config } from "./config.js";
import {
  createTempUpload,
  installJar,
  listAddons,
  removeAddon,
} from "./addons.js";
import { installDatapack, resolveLevelName } from "./datapacks.js";

// One marketplace install per server at a time. jobs.run is fire-and-forget
// with no concurrency limit, so without this a burst of clicks becomes a burst
// of simultaneous downloads. Mirrors the activeBackups guard in backups.ts.
const activeInstalls = new Set<string>();

function httpError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}

export function isInstalling(serverId: string): boolean {
  return activeInstalls.has(serverId);
}

/** Rejects a project type this server can never load, before any upstream call. */
export function assertInstallable(
  serverConfig: ServerConfig,
  projectType: MarketplaceProjectType,
): MarketplaceTarget {
  const target = marketplaceTargetFor(serverConfig.type, projectType);
  if (target === "browse-only") {
    throw httpError(
      projectType === "shader"
        ? "Shaders are installed by each player in their own Minecraft client, not on the server."
        : "Resource packs are delivered to players by URL in server.properties, not installed as files.",
      400,
    );
  }
  if (target === "unsupported") {
    throw httpError(
      `A ${serverConfig.type} server cannot load ${projectType} content.`,
      400,
    );
  }
  return target;
}

function primaryFile(version: ModrinthVersionSummary): ModrinthVersionFile {
  const chosen = version.files.find((file) => file.primary) ?? version.files[0];
  if (!chosen) {
    throw httpError("That version has no downloadable file", 502);
  }
  return chosen;
}

function expectedExtension(target: MarketplaceTarget) {
  return target === "datapacks" ? ".zip" : ".jar";
}

/**
 * Rank release over beta over alpha, newest first inside a tier. Prereleases are
 * kept because for a brand-new Minecraft version they are often all that exists.
 */
const channelRank = { release: 0, beta: 1, alpha: 2 } as const;

export function pickBestVersion(
  versions: ModrinthVersionSummary[],
  extension: string,
): ModrinthVersionSummary | null {
  const usable = versions.filter((version) =>
    version.files.some((file) =>
      file.filename.toLowerCase().endsWith(extension),
    ),
  );
  if (!usable.length) return null;
  return [...usable].sort((a, b) => {
    const byChannel = channelRank[a.versionType] - channelRank[b.versionType];
    if (byChannel !== 0) return byChannel;
    return (b.datePublished ?? "").localeCompare(a.datePublished ?? "");
  })[0]!;
}

interface ResolvedItem {
  version: ModrinthVersionSummary;
  file: ModrinthVersionFile;
  projectTitle: string;
  exactMatch: boolean;
  alreadyInstalled: boolean;
  hasNestedDependencies: boolean;
}

async function projectTitle(
  modrinth: ModrinthApi,
  projectId: string,
): Promise<string> {
  try {
    return (await modrinth.getProject(projectId)).title;
  } catch {
    return projectId;
  }
}

async function installedFilenames(
  store: Store,
  serverId: string,
  paths: InstancePaths,
): Promise<{ names: Set<string>; sources: AddonSourceRow[] }> {
  const files = await listAddons(paths.addons).catch(() => []);
  return {
    names: new Set(files.map((file) => file.name.toLowerCase())),
    sources: store.listAddonSources(serverId),
  };
}

export interface ResolveContext {
  store: Store;
  modrinth: ModrinthApi;
  serverId: string;
  serverConfig: ServerConfig;
  paths: InstancePaths;
}

/**
 * Resolves the chosen version plus its one-level required dependencies. Deeper
 * transitive resolution needs a real solver and is deliberately out of scope;
 * a dependency that itself has requirements is flagged instead.
 */
export async function resolveInstall(
  context: ResolveContext,
  input: { versionId: string; projectType: MarketplaceProjectType },
): Promise<{
  target: MarketplaceTarget;
  primary: ResolvedItem;
  dependencies: ResolvedItem[];
  optional: Array<{ projectId: string; projectTitle: string }>;
  incompatible: Array<{
    projectId: string;
    projectTitle: string;
    installed: boolean;
  }>;
  warnings: string[];
}> {
  const { modrinth, serverConfig } = context;
  const target = assertInstallable(serverConfig, input.projectType);
  const extension = expectedExtension(target);
  const version = await modrinth.getVersion(input.versionId);
  const file = primaryFile(version);
  const warnings: string[] = [];

  if (!file.filename.toLowerCase().endsWith(extension)) {
    throw httpError(
      target === "datapacks"
        ? `That version ships ${file.filename}, which is not a datapack ZIP.`
        : `That version ships ${file.filename}, which is not a JAR.`,
      400,
    );
  }

  const installed = await installedFilenames(
    context.store,
    context.serverId,
    context.paths,
  );

  const primary: ResolvedItem = {
    version,
    file,
    projectTitle: await projectTitle(modrinth, version.projectId),
    exactMatch: true,
    alreadyInstalled: installed.names.has(file.filename.toLowerCase()),
    hasNestedDependencies: false,
  };

  const dependencies: ResolvedItem[] = [];
  const optional: Array<{ projectId: string; projectTitle: string }> = [];
  const incompatible: Array<{
    projectId: string;
    projectTitle: string;
    installed: boolean;
  }> = [];
  const seen = new Set<string>([version.projectId]);

  for (const dependency of version.dependencies) {
    // Embedded dependencies are already inside the jar.
    if (dependency.dependencyType === "embedded") continue;
    if (!dependency.projectId && !dependency.versionId) continue;

    if (dependency.dependencyType === "optional") {
      if (dependency.projectId && !seen.has(dependency.projectId)) {
        seen.add(dependency.projectId);
        optional.push({
          projectId: dependency.projectId,
          projectTitle: await projectTitle(modrinth, dependency.projectId),
        });
      }
      continue;
    }

    if (dependency.dependencyType === "incompatible") {
      if (dependency.projectId) {
        const sources = installed.sources.filter(
          (source) => source.project_id === dependency.projectId,
        );
        incompatible.push({
          projectId: dependency.projectId,
          projectTitle: await projectTitle(modrinth, dependency.projectId),
          installed: sources.length > 0,
        });
      }
      continue;
    }

    const resolved = await resolveDependency(
      context,
      dependency,
      input.projectType,
      extension,
      installed,
      warnings,
    );
    if (!resolved) continue;
    if (seen.has(resolved.version.projectId)) continue;
    seen.add(resolved.version.projectId);
    dependencies.push(resolved);
  }

  return { target, primary, dependencies, optional, incompatible, warnings };
}

async function resolveDependency(
  context: ResolveContext,
  dependency: { projectId: string | null; versionId: string | null },
  projectType: MarketplaceProjectType,
  extension: string,
  installed: { names: Set<string>; sources: AddonSourceRow[] },
  warnings: string[],
): Promise<ResolvedItem | null> {
  const { modrinth, serverConfig } = context;

  // An explicit version id is authoritative.
  if (dependency.versionId) {
    const version = await modrinth.getVersion(dependency.versionId);
    const file = primaryFile(version);
    return {
      version,
      file,
      projectTitle: await projectTitle(modrinth, version.projectId),
      exactMatch: true,
      alreadyInstalled: installed.names.has(file.filename.toLowerCase()),
      hasNestedDependencies: version.dependencies.some(
        (entry) => entry.dependencyType === "required",
      ),
    };
  }

  const projectId = dependency.projectId;
  if (!projectId) return null;
  const title = await projectTitle(modrinth, projectId);

  const filtered = await modrinth.listVersions({
    idOrSlug: projectId,
    serverType: serverConfig.type,
    gameVersion: serverConfig.version,
    projectType,
  });
  let best = pickBestVersion(filtered, extension);
  let exactMatch = true;

  if (!best) {
    // Retry without the Minecraft version constraint so a slightly stale
    // dependency is offered with a caution rather than silently dropped.
    const loose = await modrinth.listVersions({
      idOrSlug: projectId,
      serverType: serverConfig.type,
      gameVersion: "LATEST",
      projectType,
    });
    best = pickBestVersion(loose, extension);
    exactMatch = false;
    if (best) {
      warnings.push(
        `${title} has no build for this Minecraft version; ${best.versionNumber} was selected instead.`,
      );
    }
  }

  if (!best) {
    throw httpError(
      `Required dependency ${title} has no compatible version for this server.`,
      409,
    );
  }

  const file = primaryFile(best);
  return {
    version: best,
    file,
    projectTitle: title,
    exactMatch,
    alreadyInstalled: installed.names.has(file.filename.toLowerCase()),
    hasNestedDependencies: best.dependencies.some(
      (entry) => entry.dependencyType === "required",
    ),
  };
}

function previewEntry(item: ResolvedItem): ModrinthPreviewEntry {
  return {
    projectId: item.version.projectId,
    projectTitle: item.projectTitle,
    versionId: item.version.id,
    versionNumber: item.version.versionNumber,
    filename: item.file.filename,
    sizeBytes: item.file.size,
    exactMatch: item.exactMatch,
    alreadyInstalled: item.alreadyInstalled,
    hasNestedDependencies: item.hasNestedDependencies,
  };
}

export async function buildPreview(
  context: ResolveContext,
  input: { versionId: string; projectType: MarketplaceProjectType },
): Promise<ModrinthInstallPreview> {
  const resolved = await resolveInstall(context, input);
  const warnings = [...resolved.warnings];
  let levelName: string | null = null;
  let worldMissing = false;

  if (resolved.target === "datapacks") {
    levelName = await resolveLevelName(
      context.paths.data,
      context.serverConfig,
    );
    const { pathExists } = await import("./utils.js");
    worldMissing = !(await pathExists(
      path.join(context.paths.data, levelName),
    ));
    if (worldMissing) {
      warnings.push(
        `World "${levelName}" does not exist yet. It will be created, so double-check the level name.`,
      );
    }
    warnings.push(
      "Datapacks need a server restart, or /reload plus /datapack enable, before they take effect.",
    );
  }

  if (resolved.primary.alreadyInstalled) {
    warnings.push(`${resolved.primary.file.filename} is already installed.`);
  }

  return {
    target: resolved.target,
    projectType: input.projectType,
    primary: previewEntry(resolved.primary),
    dependencies: resolved.dependencies.map(previewEntry),
    optional: resolved.optional,
    incompatible: resolved.incompatible,
    levelName,
    worldMissing,
    warnings,
    restartRequired: true,
  };
}

interface StagedDownload {
  item: ResolvedItem;
  tempPath: string;
}

/**
 * Downloads and verifies everything first, then installs, so a bad dependency
 * can never leave a half-installed set behind.
 */
export async function runInstall(
  context: ResolveContext,
  input: {
    versionId: string;
    projectType: MarketplaceProjectType;
    includeRequiredDependencies: boolean;
    acknowledgeLevelName?: string | undefined;
  },
): Promise<string> {
  const { serverId } = context;
  if (activeInstalls.has(serverId)) {
    throw httpError(
      "An add-on install is already running for this server",
      409,
    );
  }
  activeInstalls.add(serverId);
  try {
    const resolved = await resolveInstall(context, input);
    const items = [resolved.primary];
    if (input.includeRequiredDependencies) {
      items.push(
        ...resolved.dependencies.filter((item) => !item.alreadyInstalled),
      );
    }

    let levelName = "";
    if (resolved.target === "datapacks") {
      levelName = await resolveLevelName(
        context.paths.data,
        context.serverConfig,
      );
      if (
        input.acknowledgeLevelName &&
        input.acknowledgeLevelName !== levelName
      ) {
        throw httpError(
          `This server now uses world "${levelName}". Review the install and try again.`,
          409,
        );
      }
    }

    const staged: StagedDownload[] = [];
    try {
      for (const item of items) {
        const temp = await createTempUpload(config.tempRoot);
        const expected: ExpectedFile = {
          url: item.file.url,
          filename: item.file.filename,
          sizeBytes: item.file.size,
          sha512: item.file.sha512,
          sha1: item.file.sha1,
        };
        await context.modrinth.downloadFile(expected, temp);
        staged.push({ item, tempPath: temp.path });
      }

      const undo: Array<() => Promise<void>> = [];
      const installedNames: string[] = [];
      try {
        for (const entry of staged) {
          if (resolved.target === "datapacks") {
            const result = await installDatapack(
              entry.tempPath,
              entry.item.file.filename,
              context.paths.data,
              levelName,
            );
            installedNames.push(result.filename);
            const worldDir = path.join(context.paths.data, levelName);
            const datapacksDir = path.join(worldDir, "datapacks");
            const target = path.join(datapacksDir, result.filename);
            undo.push(async () => {
              await rm(target, { force: true });
              // Installing into a world that did not exist creates two
              // directories as a side effect; a rollback should not leave them
              // behind, because their presence changes what a later preview
              // reports. rmdir refuses a non-empty directory, which is exactly
              // the guard wanted here.
              if (result.worldCreated) {
                await rmdir(datapacksDir).catch(() => undefined);
                await rmdir(worldDir).catch(() => undefined);
              }
            });
          } else {
            const filename = await installJar(
              entry.tempPath,
              entry.item.file.filename,
              context.paths.addons,
            );
            installedNames.push(filename);
            undo.push(() =>
              removeAddon(context.paths.addons, filename).catch(
                () => undefined,
              ),
            );
            context.store.recordAddonSource({
              server_id: serverId,
              filename,
              provider: "modrinth",
              project_id: entry.item.version.projectId,
              project_title: entry.item.projectTitle,
              version_id: entry.item.version.id,
              version_number: entry.item.version.versionNumber,
              sha512: entry.item.file.sha512,
              installed_at: new Date().toISOString(),
            });
          }
        }
      } catch (error) {
        await Promise.all(undo.map((step) => step().catch(() => undefined)));
        for (const filename of installedNames) {
          context.store.deleteAddonSource(serverId, filename);
        }
        throw error;
      }

      context.store.touchServerRevision(serverId);
      const summary =
        installedNames.length === 1
          ? `Installed ${installedNames[0]}`
          : `Installed ${installedNames.length} files: ${installedNames.join(", ")}`;
      return resolved.target === "datapacks"
        ? `${summary} into world "${levelName}"`
        : summary;
    } finally {
      await Promise.all(
        staged.map((entry) =>
          rm(entry.tempPath, { force: true }).catch(() => undefined),
        ),
      );
    }
  } finally {
    activeInstalls.delete(serverId);
  }
}
