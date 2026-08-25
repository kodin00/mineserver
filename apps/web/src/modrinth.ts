import {
  maxSearchLimit,
  maxSearchOffset,
  type MarketplaceProjectType,
  type ModrinthDependencySummary,
  type ModrinthSortIndex,
  type ModrinthVersionFile,
  type ModrinthVersionSummary,
} from "@mineserver/shared";

export const pageSize = 20;

export interface SearchDescriptor {
  q: string;
  projectType: MarketplaceProjectType;
  serverType: string;
  gameVersion: string;
  sort: ModrinthSortIndex;
  offset: number;
  limit: number;
  categories: string[];
}

export function buildSearchQuery(input: SearchDescriptor): string {
  const params = new URLSearchParams({
    q: input.q,
    projectType: input.projectType,
    serverType: input.serverType,
    gameVersion: input.gameVersion,
    sort: input.sort,
    limit: String(Math.min(Math.max(input.limit, 1), maxSearchLimit)),
    offset: String(Math.min(Math.max(input.offset, 0), maxSearchOffset)),
  });
  if (input.categories.length) {
    params.set("categories", input.categories.join(","));
  }
  return params.toString();
}

export function pageLabel(
  offset: number,
  count: number,
  totalHits: number,
): string {
  if (count === 0) return "No results";
  const first = offset + 1;
  const last = offset + count;
  return `Showing ${first}–${last} of ${totalHits.toLocaleString()}`;
}

export function hasNextPage(
  offset: number,
  count: number,
  totalHits: number,
): boolean {
  if (count === 0) return false;
  if (offset + count >= totalHits) return false;
  return offset + count <= maxSearchOffset;
}

export function primaryFile(
  version: ModrinthVersionSummary,
): ModrinthVersionFile | null {
  return version.files.find((file) => file.primary) ?? version.files[0] ?? null;
}

const channelRank: Record<string, number> = { release: 0, beta: 1, alpha: 2 };

/**
 * Prefers a stable release but falls back to a prerelease, because for a very
 * new Minecraft version a beta is often the only build that exists.
 */
export function pickDefaultVersion(
  versions: ModrinthVersionSummary[],
): ModrinthVersionSummary | null {
  if (!versions.length) return null;
  return (
    versions.find((version) => version.versionType === "release") ??
    [...versions].sort(
      (a, b) => channelRank[a.versionType]! - channelRank[b.versionType]!,
    )[0] ??
    null
  );
}

export function requiredDependencies(
  version: ModrinthVersionSummary,
): ModrinthDependencySummary[] {
  const seen = new Set<string>();
  const required: ModrinthDependencySummary[] = [];
  for (const dependency of version.dependencies) {
    if (dependency.dependencyType !== "required") continue;
    // An unidentified dependency still has to be shown, so key it uniquely
    // rather than dropping it.
    const key = dependency.projectId ?? dependency.versionId ?? "";
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    required.push(dependency);
  }
  return required;
}

/**
 * Exact filename equality only. This never claims a project is absent, it only
 * asserts that this specific file is already on disk, which is the direction
 * that cannot mislead. A renamed jar or a different version of the same project
 * reads as not installed.
 */
export function isVersionInstalled(
  filename: string | null,
  installedNames: Set<string>,
): boolean {
  return filename !== null && installedNames.has(filename.toLowerCase());
}

export function describeVersionChannel(versionType: string): string {
  if (versionType === "release") return "Release";
  if (versionType === "beta") return "Beta";
  if (versionType === "alpha") return "Alpha";
  return versionType;
}

/** Human-readable summary of the filters that produced a result set. */
export function describeFacets(
  gameVersionApplied: boolean,
  typeLabel: string,
  gameVersion: string,
  categories: string[],
): string {
  const parts = [typeLabel];
  if (gameVersionApplied) parts.push(gameVersion);
  parts.push(...categories);
  return parts.join(" · ");
}
