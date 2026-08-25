import { z } from "zod";
import { ServerTypeSchema, type ServerType } from "./server-type.js";

export const modrinthProjectTypes = [
  "mod",
  "plugin",
  "datapack",
  "resourcepack",
  "shader",
] as const;
export const MarketplaceProjectTypeSchema = z.enum(modrinthProjectTypes);
export type MarketplaceProjectType = (typeof modrinthProjectTypes)[number];

export const modrinthSortIndexes = [
  "relevance",
  "downloads",
  "follows",
  "newest",
  "updated",
] as const;
export const ModrinthSortSchema = z.enum(modrinthSortIndexes);
export type ModrinthSortIndex = (typeof modrinthSortIndexes)[number];

export const versionChannels = ["release", "beta", "alpha"] as const;
export type VersionChannel = (typeof versionChannels)[number];

/**
 * Where an installed file for a project type ends up. "browse-only" means the
 * panel can show the project but a Minecraft server has nowhere to put it.
 */
export type MarketplaceTarget =
  "addons" | "datapacks" | "browse-only" | "unsupported";

/**
 * Modrinth models plugins and datapacks as loaders rather than as a property of
 * the project, so the loader facet is what actually narrows a search. Purpur,
 * Folia and Quilt are deliberately absent: a plugin that requires Purpur will
 * not run on Paper, and a server that fails to boot is worse than a shorter
 * list of results.
 */
export function loaderFacetsFor(
  serverType: ServerType,
  projectType: MarketplaceProjectType,
): string[] {
  if (projectType === "datapack") return ["datapack"];
  if (projectType !== "mod" && projectType !== "plugin") return [];
  if (serverType === "FABRIC") return ["fabric"];
  if (serverType === "FORGE") return ["forge"];
  if (serverType === "NEOFORGE") return ["neoforge"];
  if (serverType === "PAPER") return ["paper", "bukkit", "spigot"];
  return [];
}

/**
 * Returns the Minecraft version only when it is concrete enough to filter on.
 * "LATEST", "SNAPSHOT" and snapshot names such as "24w40a" have no matching
 * Modrinth `versions:` facet.
 */
export function concreteGameVersion(version: string): string | null {
  const trimmed = version.trim();
  return /^\d+\.\d+(?:\.\d+)?$/.test(trimmed) ? trimmed : null;
}

export function marketplaceTargetFor(
  serverType: ServerType,
  projectType: MarketplaceProjectType,
): MarketplaceTarget {
  if (projectType === "resourcepack" || projectType === "shader") {
    return "browse-only";
  }
  if (projectType === "datapack") return "datapacks";
  const kind = addonKindFor(serverType);
  if (projectType === "mod" && kind === "mods") return "addons";
  if (projectType === "plugin" && kind === "plugins") return "addons";
  return "unsupported";
}

// Local mirror of addonKind so this module does not import it at runtime and
// create a cycle with index.ts.
function addonKindFor(type: ServerType): "mods" | "plugins" | null {
  if (type === "PAPER") return "plugins";
  if (type === "FABRIC" || type === "FORGE" || type === "NEOFORGE") {
    return "mods";
  }
  return null;
}

export function supportedMarketplaceTypes(
  serverType: ServerType,
): MarketplaceProjectType[] {
  return modrinthProjectTypes.filter(
    (type) => marketplaceTargetFor(serverType, type) !== "unsupported",
  );
}

export const maxSearchLimit = 50;
export const maxSearchOffset = 500;

const categoryPattern = /^[a-z0-9-]{1,32}$/;
export const maxSearchCategories = 5;

/**
 * Builds Modrinth's facet structure: the outer array is ANDed, each inner array
 * is ORed. Callers never supply raw facets, so every value here is derived from
 * validated input.
 */
export function buildModrinthFacets(input: {
  serverType: ServerType;
  gameVersion: string;
  projectType: MarketplaceProjectType;
  categories?: string[];
}): string[][] {
  const { serverType, gameVersion, projectType } = input;
  const facets: string[][] = [[`project_type:${projectType}`]];

  const loaders = loaderFacetsFor(serverType, projectType);
  if (loaders.length) {
    facets.push(loaders.map((loader) => `categories:${loader}`));
  }

  // Shader compatibility tracks the player's client, not the server's world.
  if (projectType !== "shader") {
    const concrete = concreteGameVersion(gameVersion);
    if (concrete) facets.push([`versions:${concrete}`]);
  }

  // Verified against the live API: the != operator is accepted on v2, so this
  // filtering happens upstream and total_hits stays truthful.
  if (
    projectType === "mod" ||
    projectType === "plugin" ||
    projectType === "datapack"
  ) {
    facets.push(["server_side!=unsupported"]);
  }

  for (const category of (input.categories ?? []).slice(
    0,
    maxSearchCategories,
  )) {
    if (!categoryPattern.test(category)) {
      throw new Error(`Invalid marketplace category: ${category}`);
    }
    facets.push([`categories:${category}`]);
  }

  return facets;
}

export function parseSearchCategories(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, maxSearchCategories);
}

export const ModrinthSearchQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
  projectType: MarketplaceProjectTypeSchema.default("mod"),
  serverType: ServerTypeSchema.default("PAPER"),
  gameVersion: z.string().trim().max(40).default("LATEST"),
  categories: z.string().trim().max(200).optional(),
  sort: ModrinthSortSchema.default("relevance"),
  // Modrinth allows a higher limit and deeper offsets; both are capped harder
  // here because the 300 requests per minute budget is shared by every panel
  // user. Out-of-range values are clamped rather than rejected so a client bug
  // degrades into a smaller page instead of a failed search.
  limit: z.coerce
    .number()
    .int()
    .default(20)
    .transform((value) => Math.min(Math.max(value, 1), maxSearchLimit)),
  offset: z.coerce
    .number()
    .int()
    .default(0)
    .transform((value) => Math.min(Math.max(value, 0), maxSearchOffset)),
});
export type ModrinthSearchQuery = z.infer<typeof ModrinthSearchQuerySchema>;

export const ModrinthVersionQuerySchema = z.object({
  projectType: MarketplaceProjectTypeSchema.default("mod"),
  serverType: ServerTypeSchema.default("PAPER"),
  gameVersion: z.string().trim().max(40).default("LATEST"),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});

const versionIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{8}$/, "Invalid Modrinth version id");

export const ModrinthPreviewSchema = z.object({
  versionId: versionIdSchema,
  projectType: MarketplaceProjectTypeSchema,
});

export const ModrinthInstallSchema = z.object({
  versionId: versionIdSchema,
  projectType: MarketplaceProjectTypeSchema,
  includeRequiredDependencies: z.boolean().default(false),
  // Optional guard so a client that showed the user one world name cannot
  // silently install into another.
  acknowledgeLevelName: z.string().trim().max(64).optional(),
});
export type ModrinthInstallInput = z.infer<typeof ModrinthInstallSchema>;

export interface ModrinthSearchHit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  author: string | null;
  /**
   * The primary type Modrinth reports, which is "mod" even for pure datapacks.
   * Prefer allProjectTypes when labelling a hit.
   */
  projectType: string;
  allProjectTypes: string[];
  categories: string[];
  displayCategories: string[];
  downloads: number;
  follows: number;
  iconUrl: string | null;
  dateModified: string | null;
  license: string | null;
  clientSide: string | null;
  serverSide: string | null;
  gameVersions: string[];
}

export interface ModrinthSearchResult {
  hits: ModrinthSearchHit[];
  offset: number;
  limit: number;
  totalHits: number;
  /** False when the server tracks LATEST/SNAPSHOT and no version facet applied. */
  gameVersionApplied: boolean;
  appliedFacets: string[][];
}

export interface ModrinthVersionFile {
  url: string;
  filename: string;
  primary: boolean;
  size: number;
  sha512: string;
  sha1: string | null;
}

export interface ModrinthDependencySummary {
  projectId: string | null;
  versionId: string | null;
  title: string | null;
  dependencyType: "required" | "optional" | "incompatible" | "embedded";
}

export interface ModrinthVersionSummary {
  id: string;
  projectId: string;
  name: string;
  versionNumber: string;
  versionType: VersionChannel;
  loaders: string[];
  gameVersions: string[];
  datePublished: string | null;
  downloads: number;
  files: ModrinthVersionFile[];
  dependencies: ModrinthDependencySummary[];
}

export interface ModrinthProjectDetail {
  id: string;
  slug: string;
  title: string;
  description: string;
  projectType: string;
  categories: string[];
  loaders: string[];
  gameVersions: string[];
  iconUrl: string | null;
  license: string | null;
  sourceUrl: string | null;
  issuesUrl: string | null;
  downloads: number;
  projectUrl: string;
}

export interface ModrinthTags {
  categories: string[];
  loaders: string[];
  gameVersions: string[];
}

export interface ModrinthPreviewEntry {
  projectId: string;
  projectTitle: string;
  versionId: string;
  versionNumber: string;
  filename: string;
  sizeBytes: number;
  exactMatch: boolean;
  alreadyInstalled: boolean;
  hasNestedDependencies: boolean;
}

export interface ModrinthInstallPreview {
  target: MarketplaceTarget;
  projectType: MarketplaceProjectType;
  primary: ModrinthPreviewEntry;
  dependencies: ModrinthPreviewEntry[];
  optional: Array<{ projectId: string; projectTitle: string }>;
  incompatible: Array<{
    projectId: string;
    projectTitle: string;
    installed: boolean;
  }>;
  levelName: string | null;
  worldMissing: boolean;
  warnings: string[];
  restartRequired: boolean;
}

/** Public project page. /project/<slug> redirects to the type-specific route. */
export function modrinthProjectUrl(slug: string): string {
  return `https://modrinth.com/project/${slug}`;
}

/**
 * Panel-wide marketplace settings, edited on the settings page rather than
 * through environment variables.
 *
 * Modrinth needs no credential to browse or download public projects, and a
 * token does not raise the shared 300 requests per minute limit. The token is
 * only useful for reaching projects that are private to its owner, so it is
 * optional everywhere.
 */
export const MarketplaceSettingsSchema = z.object({
  enabled: z.boolean(),
  // Modrinth recommends contact details in the User-Agent so they can reach an
  // operator about API usage instead of silently blocking their traffic.
  contact: z
    .string()
    .trim()
    .max(120)
    // This lands in an outbound User-Agent header. A control character would
    // make every marketplace request fail in the HTTP client, so reject it
    // here instead of relying on that failure.
    .refine(
      (value) => !/[\u0000-\u001f\u007f]/.test(value),
      "Contact details cannot contain control characters",
    )
    .default(""),
  // undefined leaves the stored token alone; null or "" clears it.
  token: z
    .string()
    .trim()
    .max(256)
    .refine(
      (value) => value === "" || !/\s/.test(value),
      "A token cannot contain spaces",
    )
    .nullable()
    .optional(),
});
export type MarketplaceSettingsInput = z.infer<
  typeof MarketplaceSettingsSchema
>;

/** What the API returns. The token itself is never sent back to a client. */
export interface MarketplaceSettings {
  enabled: boolean;
  contact: string;
  hasToken: boolean;
  userAgent: string;
  tokenUpdatedAt: string | null;
  /**
   * Result of the last check against Modrinth: "valid", "invalid",
   * "unchecked" when no token is stored, or "unreachable" if Modrinth could
   * not be asked.
   */
  tokenStatus: "valid" | "invalid" | "unchecked" | "unreachable";
}

/**
 * Builds the User-Agent Modrinth requires. Their recommended shape is
 * `user/project/version (contact)`, so an operator-supplied contact replaces
 * the default parenthetical rather than being appended after it.
 */
export function composeUserAgent(base: string, contact: string): string {
  const trimmed = contact.trim();
  if (!trimmed) return base;
  const withoutContact = base.replace(/\s*\([^()]*\)\s*$/, "").trim();
  return `${withoutContact} (${trimmed})`;
}
