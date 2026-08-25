import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  buildModrinthFacets,
  concreteGameVersion,
  loaderFacetsFor,
  modrinthProjectUrl,
  type MarketplaceProjectType,
  type ModrinthDependencySummary,
  type ModrinthProjectDetail,
  type ModrinthSearchHit,
  type ModrinthSearchResult,
  type ModrinthSortIndex,
  type ModrinthTags,
  type ModrinthVersionFile,
  type ModrinthVersionSummary,
  type ServerType,
} from "@mineserver/shared";

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    redirect?: "manual";
    signal?: AbortSignal;
  },
) => Promise<Response>;

export interface ModrinthCredentials {
  userAgent: string;
  /** Optional Modrinth personal access token. Never logged, never echoed. */
  token: string | null;
}

export interface ModrinthClientOptions {
  /**
   * Read on every request so a settings change takes effect immediately
   * instead of needing a panel restart.
   */
  credentials: () => ModrinthCredentials;
  baseUrl: string;
  cdnHost: string;
  requestsPerMinute: number;
  apiTimeoutMs: number;
  downloadTimeoutMs: number;
  maxFileBytes: number;
  fetch?: FetchLike;
  now?: () => number;
}

export interface SearchInput {
  query: string;
  serverType: ServerType;
  gameVersion: string;
  projectType: MarketplaceProjectType;
  categories: string[];
  sort: ModrinthSortIndex;
  limit: number;
  offset: number;
}

export interface VersionQuery {
  idOrSlug: string;
  serverType: ServerType;
  gameVersion: string;
  projectType: MarketplaceProjectType;
}

export interface ExpectedFile {
  url: string;
  filename: string;
  sizeBytes: number;
  sha512: string;
  sha1: string | null;
}

export interface ModrinthApi {
  search(input: SearchInput): Promise<ModrinthSearchResult>;
  getProject(idOrSlug: string): Promise<ModrinthProjectDetail>;
  listVersions(input: VersionQuery): Promise<ModrinthVersionSummary[]>;
  getVersion(versionId: string): Promise<ModrinthVersionSummary>;
  tags(): Promise<ModrinthTags>;
  downloadFile(
    expected: ExpectedFile,
    temp: { path: string; stream: NodeJS.WritableStream },
  ): Promise<void>;
  /** Drops cached responses, e.g. after the credentials change. */
  invalidate(): void;
  /**
   * Checks whether the stored token authenticates. Returns null when no token
   * is set, so "no token" is never reported as "bad token".
   */
  checkToken(): Promise<boolean | null>;
}

/**
 * Releases the response body. Undici will not return the underlying socket to
 * the keep-alive pool until the body is read or cancelled, so a run of upstream
 * errors would otherwise exhaust the connection pool.
 */
async function discardBody(response: Response) {
  await response.body?.cancel().catch(() => undefined);
}

function httpError(message: string, statusCode: number, extra?: object) {
  return Object.assign(new Error(message), { statusCode }, extra ?? {});
}

const unavailable = () => httpError("The mod marketplace is unavailable", 502);

/**
 * Caches the in-flight promise rather than the resolved value, so several panel
 * tabs asking the same question cost one upstream request. Insertion-ordered
 * Map keys give FIFO eviction for free.
 */
class TtlCache<T> {
  private readonly entries = new Map<
    string,
    { value: Promise<T>; expires: number }
  >();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number,
  ) {}

  clear() {
    this.entries.clear();
  }

  fetch(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing && existing.expires > this.now()) return existing.value;
    const value = load();
    this.entries.delete(key);
    this.entries.set(key, { value, expires: this.now() + this.ttlMs });
    // A rejected request must not be remembered, or one blip poisons the key
    // for the whole TTL.
    value.catch(() => this.entries.delete(key));
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    return value;
  }
}

// Unknown keys are stripped by zod rather than rejected, so new upstream fields
// are tolerated automatically. Everything but the identifiers is optional so a
// removed field degrades instead of failing the whole request.
const RawHitSchema = z.object({
  project_id: z.string(),
  slug: z.string(),
  project_type: z.string().default("mod"),
  all_project_types: z.array(z.string()).default([]),
  title: z.string().default(""),
  description: z.string().default(""),
  author: z.string().nullish(),
  categories: z.array(z.string()).default([]),
  display_categories: z.array(z.string()).default([]),
  versions: z.array(z.string()).default([]),
  downloads: z.number().default(0),
  follows: z.number().default(0),
  icon_url: z.string().nullish(),
  date_modified: z.string().nullish(),
  license: z.string().nullish(),
  client_side: z.string().nullish(),
  server_side: z.string().nullish(),
});

const RawSearchSchema = z.object({
  hits: z.array(RawHitSchema).default([]),
  offset: z.number().default(0),
  limit: z.number().default(0),
  total_hits: z.number().default(0),
});

const RawFileSchema = z.object({
  url: z.string(),
  filename: z.string(),
  primary: z.boolean().default(false),
  size: z.number().default(0),
  hashes: z
    .object({ sha512: z.string().nullish(), sha1: z.string().nullish() })
    .default({}),
});

const RawDependencySchema = z.object({
  project_id: z.string().nullish(),
  version_id: z.string().nullish(),
  dependency_type: z
    .enum(["required", "optional", "incompatible", "embedded"])
    .default("optional"),
});

const RawVersionSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  name: z.string().default(""),
  version_number: z.string().default(""),
  version_type: z.enum(["release", "beta", "alpha"]).default("release"),
  loaders: z.array(z.string()).default([]),
  game_versions: z.array(z.string()).default([]),
  date_published: z.string().nullish(),
  downloads: z.number().default(0),
  files: z.array(RawFileSchema).default([]),
  dependencies: z.array(RawDependencySchema).default([]),
});

const RawProjectSchema = z.object({
  id: z.string(),
  slug: z.string().nullish(),
  title: z.string().default(""),
  description: z.string().default(""),
  project_type: z.string().default("mod"),
  categories: z.array(z.string()).default([]),
  loaders: z.array(z.string()).default([]),
  game_versions: z.array(z.string()).default([]),
  icon_url: z.string().nullish(),
  license: z
    .object({ id: z.string().nullish(), name: z.string().nullish() })
    .nullish(),
  source_url: z.string().nullish(),
  issues_url: z.string().nullish(),
  downloads: z.number().default(0),
});

const RawTagNameSchema = z.array(z.object({ name: z.string() }));
const RawGameVersionSchema = z.array(
  z.object({
    version: z.string(),
    version_type: z.string().default("release"),
  }),
);

/** Only https URLs reach an <img src> or a download, so reject anything else. */
function httpsOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function normalizeHit(raw: z.infer<typeof RawHitSchema>): ModrinthSearchHit {
  return {
    projectId: raw.project_id,
    slug: raw.slug,
    title: raw.title,
    description: raw.description,
    author: raw.author ?? null,
    projectType: raw.project_type,
    allProjectTypes: raw.all_project_types.length
      ? raw.all_project_types
      : [raw.project_type],
    categories: raw.categories,
    displayCategories: raw.display_categories,
    downloads: raw.downloads,
    follows: raw.follows,
    iconUrl: httpsOrNull(raw.icon_url),
    dateModified: raw.date_modified ?? null,
    license: raw.license ?? null,
    clientSide: raw.client_side ?? null,
    serverSide: raw.server_side ?? null,
    gameVersions: raw.versions,
  };
}

function normalizeFile(
  raw: z.infer<typeof RawFileSchema>,
): ModrinthVersionFile | null {
  // Without a sha512 there is nothing to verify the download against, so the
  // file is unusable rather than merely incomplete.
  if (!raw.hashes.sha512) return null;
  return {
    url: raw.url,
    filename: raw.filename,
    primary: raw.primary,
    size: raw.size,
    sha512: raw.hashes.sha512.toLowerCase(),
    sha1: raw.hashes.sha1 ? raw.hashes.sha1.toLowerCase() : null,
  };
}

function normalizeVersion(
  raw: z.infer<typeof RawVersionSchema>,
): ModrinthVersionSummary {
  const dependencies: ModrinthDependencySummary[] = raw.dependencies.map(
    (dependency) => ({
      projectId: dependency.project_id ?? null,
      versionId: dependency.version_id ?? null,
      title: null,
      dependencyType: dependency.dependency_type,
    }),
  );
  return {
    id: raw.id,
    projectId: raw.project_id,
    name: raw.name,
    versionNumber: raw.version_number,
    versionType: raw.version_type,
    loaders: raw.loaders,
    gameVersions: raw.game_versions,
    datePublished: raw.date_published ?? null,
    downloads: raw.downloads,
    files: raw.files
      .map(normalizeFile)
      .filter((file): file is ModrinthVersionFile => file !== null),
    dependencies,
  };
}

export class ModrinthClient implements ModrinthApi {
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly baseUrl: string;
  private readonly allowedDownloadHosts: Set<string>;

  private tokens: number;
  private lastRefill: number;
  private blockedUntil = 0;
  private blockedSeconds = 0;

  private readonly searchCache: TtlCache<ModrinthSearchResult>;
  private readonly projectCache: TtlCache<ModrinthProjectDetail>;
  private readonly versionsCache: TtlCache<ModrinthVersionSummary[]>;
  private readonly versionCache: TtlCache<ModrinthVersionSummary>;
  private readonly tagsCache: TtlCache<ModrinthTags>;

  constructor(private readonly options: ModrinthClientOptions) {
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init as never));
    this.now = options.now ?? Date.now;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.allowedDownloadHosts = new Set([options.cdnHost]);
    this.tokens = options.requestsPerMinute;
    this.lastRefill = this.now();
    this.searchCache = new TtlCache(5 * 60_000, 200, this.now);
    this.projectCache = new TtlCache(15 * 60_000, 200, this.now);
    this.versionsCache = new TtlCache(10 * 60_000, 200, this.now);
    this.versionCache = new TtlCache(60 * 60_000, 200, this.now);
    this.tagsCache = new TtlCache(24 * 60 * 60_000, 3, this.now);
  }

  private headers(): Record<string, string> {
    const { userAgent, token } = this.options.credentials();
    return {
      "user-agent": userAgent,
      accept: "application/json",
      ...(token ? { authorization: token } : {}),
    };
  }

  /**
   * Cached responses can depend on the token, because a token can reveal
   * projects that are private to its owner.
   */
  invalidate() {
    this.searchCache.clear();
    this.projectCache.clear();
    this.versionsCache.clear();
    this.versionCache.clear();
    this.tagsCache.clear();
  }

  private busy(seconds: number): never {
    throw httpError(
      "The mod marketplace is busy. Try again in a moment.",
      503,
      { retryAfterSeconds: seconds },
    );
  }

  /**
   * Refuses rather than queues when the local budget is spent: a queued request
   * just turns a fast 503 into a slow one while still holding a connection.
   */
  private takeToken() {
    const now = this.now();
    if (this.blockedUntil > now) {
      this.busy(Math.max(1, Math.ceil((this.blockedUntil - now) / 1000)));
    }
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(
        this.options.requestsPerMinute,
        this.tokens + (elapsed * this.options.requestsPerMinute) / 60_000,
      );
      this.lastRefill = now;
    }
    if (this.tokens < 1) {
      const needed =
        ((1 - this.tokens) * 60_000) / this.options.requestsPerMinute;
      this.busy(Math.max(1, Math.ceil(needed / 1000)));
    }
    this.tokens -= 1;
  }

  /** Upstream telling us it is out of budget is more authoritative than our own. */
  private observeLimits(response: Response) {
    // An absent header means "no information", not "no budget left" — parsing
    // it as a number would make every header-less response open the breaker.
    const rawRemaining = response.headers.get("x-ratelimit-remaining");
    const rawReset = response.headers.get("x-ratelimit-reset");
    const remaining = rawRemaining === null ? null : Number(rawRemaining);
    const reset = rawReset === null ? null : Number(rawReset);
    const isBlocked =
      response.status === 429 ||
      (remaining !== null && Number.isFinite(remaining) && remaining <= 0);
    if (!isBlocked) return;
    const seconds =
      reset !== null && Number.isFinite(reset) && reset > 0
        ? Math.min(reset, 120)
        : 60;
    this.blockedUntil = this.now() + seconds * 1000;
    this.blockedSeconds = seconds;
  }

  private async requestJson(path: string, search?: URLSearchParams) {
    this.takeToken();
    const url = search
      ? `${this.baseUrl}${path}?${search.toString()}`
      : `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "GET",
        headers: this.headers(),
        signal: AbortSignal.timeout(this.options.apiTimeoutMs),
      });
    } catch {
      throw unavailable();
    }
    this.observeLimits(response);
    if (response.status === 429) {
      await discardBody(response);
      this.busy(this.blockedSeconds);
    }
    if (response.status === 404) {
      await discardBody(response);
      throw httpError("Marketplace project not found", 404);
    }
    if (response.status === 400) {
      const description = await response
        .text()
        .then((text) => text.slice(0, 200))
        .catch(() => "");
      throw httpError(
        description
          ? `The marketplace rejected the request: ${description}`
          : "The marketplace rejected the request",
        400,
      );
    }
    if (!response.ok) {
      await discardBody(response);
      throw unavailable();
    }
    try {
      return await response.json();
    } catch {
      throw unavailable();
    }
  }

  // Infers from the schema so defaults are reflected in the returned type.
  private parse<S extends z.ZodTypeAny>(
    schema: S,
    payload: unknown,
  ): z.infer<S> {
    const result = schema.safeParse(payload);
    if (!result.success) throw unavailable();
    return result.data;
  }

  async search(input: SearchInput): Promise<ModrinthSearchResult> {
    const facets = buildModrinthFacets({
      serverType: input.serverType,
      gameVersion: input.gameVersion,
      projectType: input.projectType,
      categories: input.categories,
    });
    const search = new URLSearchParams({
      query: input.query,
      facets: JSON.stringify(facets),
      index: input.sort,
      limit: String(input.limit),
      offset: String(input.offset),
    });
    const key = search.toString();
    return this.searchCache.fetch(key, async () => {
      const raw = this.parse(
        RawSearchSchema,
        await this.requestJson("/search", search),
      );
      return {
        hits: raw.hits.map(normalizeHit),
        offset: raw.offset,
        limit: raw.limit,
        totalHits: raw.total_hits,
        gameVersionApplied: concreteGameVersion(input.gameVersion) !== null,
        appliedFacets: facets,
      };
    });
  }

  async getProject(idOrSlug: string): Promise<ModrinthProjectDetail> {
    return this.projectCache.fetch(idOrSlug, async () => {
      const raw = this.parse(
        RawProjectSchema,
        await this.requestJson(`/project/${encodeURIComponent(idOrSlug)}`),
      );
      const slug = raw.slug ?? raw.id;
      return {
        id: raw.id,
        slug,
        title: raw.title,
        description: raw.description,
        projectType: raw.project_type,
        categories: raw.categories,
        loaders: raw.loaders,
        gameVersions: raw.game_versions,
        iconUrl: httpsOrNull(raw.icon_url),
        license: raw.license?.name ?? raw.license?.id ?? null,
        sourceUrl: httpsOrNull(raw.source_url),
        issuesUrl: httpsOrNull(raw.issues_url),
        downloads: raw.downloads,
        projectUrl: modrinthProjectUrl(slug),
      };
    });
  }

  async listVersions(input: VersionQuery): Promise<ModrinthVersionSummary[]> {
    const search = new URLSearchParams();
    const loaders = loaderFacetsFor(input.serverType, input.projectType);
    // Verified: these are JSON-encoded arrays, not repeated params. A datapack
    // project also publishes loader jars, so this filter is what separates the
    // .zip from the .jar.
    if (loaders.length) search.set("loaders", JSON.stringify(loaders));
    const concrete = concreteGameVersion(input.gameVersion);
    if (concrete && input.projectType !== "shader") {
      search.set("game_versions", JSON.stringify([concrete]));
    }
    const path = `/project/${encodeURIComponent(input.idOrSlug)}/version`;
    const key = `${path}?${search.toString()}`;
    return this.versionsCache.fetch(key, async () => {
      const raw = this.parse(
        z.array(RawVersionSchema),
        await this.requestJson(path, search),
      );
      return raw.map(normalizeVersion);
    });
  }

  async getVersion(versionId: string): Promise<ModrinthVersionSummary> {
    return this.versionCache.fetch(versionId, async () => {
      const raw = this.parse(
        RawVersionSchema,
        await this.requestJson(`/version/${encodeURIComponent(versionId)}`),
      );
      return normalizeVersion(raw);
    });
  }

  async tags(): Promise<ModrinthTags> {
    return this.tagsCache.fetch("tags", async () => {
      const [categories, loaders, gameVersions] = await Promise.all([
        this.requestJson("/tag/category"),
        this.requestJson("/tag/loader"),
        this.requestJson("/tag/game_version"),
      ]);
      return {
        categories: [
          ...new Set(
            this.parse(RawTagNameSchema, categories).map((t) => t.name),
          ),
        ],
        loaders: this.parse(RawTagNameSchema, loaders).map((t) => t.name),
        gameVersions: this.parse(RawGameVersionSchema, gameVersions)
          .filter((entry) => entry.version_type === "release")
          .map((entry) => entry.version),
      };
    });
  }

  async checkToken(): Promise<boolean | null> {
    const { token } = this.options.credentials();
    if (!token) return null;
    this.takeToken();
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/user`, {
        method: "GET",
        headers: this.headers(),
        signal: AbortSignal.timeout(this.options.apiTimeoutMs),
      });
    } catch {
      throw unavailable();
    }
    this.observeLimits(response);
    await discardBody(response);
    if (response.status === 401 || response.status === 403) return false;
    if (response.status === 429) this.busy(this.blockedSeconds);
    if (!response.ok) throw unavailable();
    return true;
  }

  /**
   * The URL is never taken from a client request; callers pass a file from a
   * freshly fetched version object. Combined with the host pin and the refusal
   * to follow redirects, that leaves no attacker-reachable SSRF target.
   */
  async downloadFile(
    expected: ExpectedFile,
    temp: { path: string; stream: NodeJS.WritableStream },
  ): Promise<void> {
    try {
      this.assertDownloadable(expected);
      this.takeToken();
      const response = await this.fetchFn(expected.url, {
        method: "GET",
        // The CDN is a public file host; the token has no business there.
        headers: { "user-agent": this.options.credentials().userAgent },
        redirect: "manual",
        signal: AbortSignal.timeout(this.options.downloadTimeoutMs),
      }).catch(() => {
        throw httpError("The marketplace download failed", 502);
      });
      this.observeLimits(response);
      if (response.status >= 300 && response.status < 400) {
        await discardBody(response);
        throw httpError("The marketplace download was redirected", 502);
      }
      if (!response.ok || !response.body) {
        await discardBody(response);
        throw httpError("The marketplace download failed", 502);
      }
      const declared = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declared) &&
        declared > 0 &&
        declared !== expected.sizeBytes
      ) {
        await discardBody(response);
        throw httpError(
          "The marketplace download did not match its expected size",
          502,
        );
      }

      const sha512 = createHash("sha512");
      const sha1 = createHash("sha1");
      let received = 0;
      const limit = Math.min(this.options.maxFileBytes, expected.sizeBytes);
      const guard = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          received += chunk.length;
          if (received > limit) {
            callback(
              httpError(
                "The marketplace download exceeded its declared size",
                502,
              ),
            );
            return;
          }
          sha512.update(chunk);
          sha1.update(chunk);
          callback(null, chunk);
        },
      });

      await pipeline(
        Readable.fromWeb(
          response.body as Parameters<typeof Readable.fromWeb>[0],
        ),
        guard,
        temp.stream,
      );

      if (received !== expected.sizeBytes) {
        throw httpError(
          "The marketplace download did not match its expected size",
          502,
        );
      }
      if (sha512.digest("hex") !== expected.sha512) {
        throw httpError("Downloaded file failed its integrity check", 502);
      }
      if (expected.sha1 && sha1.digest("hex") !== expected.sha1) {
        throw httpError("Downloaded file failed its integrity check", 502);
      }
    } catch (error) {
      await rm(temp.path, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private assertDownloadable(expected: ExpectedFile) {
    if (expected.sizeBytes <= 0) {
      throw httpError("The marketplace file has no size", 502);
    }
    if (expected.sizeBytes > this.options.maxFileBytes) {
      throw httpError("That file is larger than this panel will download", 413);
    }
    let url: URL;
    try {
      url = new URL(expected.url);
    } catch {
      throw httpError("The marketplace returned an unusable download URL", 502);
    }
    // Exact host match only: cdn.modrinth.com.example.test must not pass.
    if (
      url.protocol !== "https:" ||
      !this.allowedDownloadHosts.has(url.hostname) ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== ""
    ) {
      throw httpError(
        "The marketplace returned a download URL the panel will not follow",
        502,
      );
    }
  }
}
