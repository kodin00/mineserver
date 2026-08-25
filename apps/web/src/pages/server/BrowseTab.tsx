import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ExternalLink,
  Heart,
  LoaderCircle,
  Package,
  PackageOpen,
  Search,
} from "lucide-react";
import {
  modrinthProjectUrl,
  marketplaceTargetFor,
  supportedMarketplaceTypes,
  type MarketplaceProjectType,
  type ModrinthSearchHit,
  type ModrinthSearchResult,
  type ModrinthSortIndex,
  type ModrinthTags,
  type Operation,
  type ServerSummary,
} from "@mineserver/shared";
import { ApiError, api } from "../../api";
import { EmptyState, ErrorBanner } from "../../components/Layout";
import {
  buildSearchQuery,
  describeFacets,
  hasNextPage,
  pageLabel,
  pageSize,
} from "../../modrinth";
import { InstallDialog } from "./InstallDialog";

const typeLabels: Record<MarketplaceProjectType, string> = {
  mod: "Mods",
  plugin: "Plugins",
  datapack: "Datapacks",
  resourcepack: "Resource packs",
  shader: "Shaders",
};

function errorText(error: unknown, fallback: string) {
  if (error instanceof ApiError) return error.message;
  // A failed fetch throws a bare TypeError, whose message ("Failed to fetch")
  // tells the operator nothing useful.
  return error instanceof Error && error.name === "TypeError"
    ? "Unable to reach the panel. Check your connection."
    : fallback;
}

export function BrowseTab({
  server,
  refresh,
}: {
  server: ServerSummary;
  refresh?: () => void;
}) {
  const allowedTypes = useMemo(
    () => supportedMarketplaceTypes(server.config.type),
    [server.config.type],
  );
  const [projectType, setProjectType] = useState<MarketplaceProjectType>(
    () => allowedTypes[0] ?? "datapack",
  );
  const [query, setQuery] = useState("");
  // An empty query has no meaningful relevance order, so lead with popularity
  // and switch to relevance the moment the operator types something.
  const [sort, setSort] = useState<ModrinthSortIndex>("downloads");
  const [categories, setCategories] = useState<string[]>([]);
  const [gameVersion, setGameVersion] = useState("");
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<ModrinthSearchResult | null>(null);
  const [tags, setTags] = useState<ModrinthTags | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [rateLimited, setRateLimited] = useState("");
  const [retried, setRetried] = useState(false);
  const [installedNames, setInstalledNames] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<ModrinthSearchHit | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [installed, setInstalled] = useState("");

  const effectiveVersion = gameVersion || server.config.version;
  const tracksMoving =
    effectiveVersion === "LATEST" || effectiveVersion === "SNAPSHOT";
  const categoryKey = categories.join(",");

  const target = marketplaceTargetFor(server.config.type, projectType);
  const canInstall = target === "addons" || target === "datapacks";
  const installBusy =
    operation !== null &&
    operation.status !== "succeeded" &&
    operation.status !== "failed";

  const loadInstalled = useCallback(async () => {
    try {
      const url =
        target === "datapacks"
          ? `/api/servers/${server.id}/datapacks`
          : `/api/servers/${server.id}/addons`;
      const response = await api<{ files: Array<{ name: string }> }>(url);
      setInstalledNames(
        new Set(response.files.map((file) => file.name.toLowerCase())),
      );
    } catch {
      // A missing installed list only weakens the duplicate warning.
    }
  }, [server.id, target]);

  useEffect(() => {
    void loadInstalled();
  }, [loadInstalled]);

  useEffect(() => {
    let cancelled = false;
    void api<ModrinthTags>("/api/modrinth/tags")
      .then((response) => {
        if (!cancelled) setTags(response);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const response = await api<ModrinthSearchResult>(
          `/api/modrinth/search?${buildSearchQuery({
            q: query.trim(),
            projectType,
            serverType: server.config.type,
            gameVersion: effectiveVersion,
            sort,
            offset,
            limit: pageSize,
            categories,
          })}`,
        );
        if (!cancelled) {
          setResult(response);
          setError("");
          setRateLimited("");
          setRetried(false);
        }
      } catch (caught) {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.status === 503) {
          // Transient and not the operator's fault, so keep the current
          // results on screen and never retry inside the debounce loop.
          setRateLimited(caught.message);
        } else {
          setError(errorText(caught, "Unable to search the marketplace"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    server.id,
    server.config.type,
    effectiveVersion,
    query,
    projectType,
    sort,
    offset,
    categoryKey,
    retried,
  ]);

  // Poll only while an install is actually running, matching how the overview
  // tab observes operations. The operations websocket has no per-server filter.
  useEffect(() => {
    if (!operation) return;
    if (operation.status === "succeeded" || operation.status === "failed")
      return;
    const timer = setInterval(() => {
      void api<Operation[]>(`/api/servers/${server.id}/operations`)
        .then((all) => {
          const next = all.find((entry) => entry.id === operation.id);
          if (next) setOperation(next);
        })
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [server.id, operation]);

  useEffect(() => {
    if (operation?.status !== "succeeded") return;
    setInstalled(operation.message ?? "Install finished.");
    setOperation(null);
    void loadInstalled();
    refresh?.();
  }, [operation, loadInstalled, refresh]);

  function applyFilter(change: () => void) {
    change();
    setOffset(0);
  }

  function switchType(next: MarketplaceProjectType) {
    applyFilter(() => {
      setProjectType(next);
      setCategories([]);
    });
  }

  if (!allowedTypes.length) {
    return (
      <div className="tab-stack">
        <EmptyState
          icon={<PackageOpen size={26} />}
          title="Nothing to browse"
          body="This server type cannot load marketplace content."
        />
      </div>
    );
  }

  const hits = result?.hits ?? [];
  const releaseVersions = tags?.gameVersions ?? [];
  const activeFilters = describeFacets(
    result?.gameVersionApplied ?? false,
    typeLabels[projectType],
    effectiveVersion,
    categories,
  );

  return (
    <div className="tab-stack">
      {!canInstall && (
        <p className="notice-banner">
          {projectType === "shader"
            ? "Shaders run in each player's own Minecraft client, so the panel cannot install them. Browse and share the link instead."
            : "Resource packs are delivered to players by URL in server.properties, so there is nothing to install here yet."}
        </p>
      )}

      {installed && <p className="notice-banner">{installed}</p>}
      {error && <ErrorBanner message={error} />}
      {rateLimited && (
        <p className="notice-banner">
          {rateLimited}{" "}
          <button
            className="button ghost"
            onClick={() => setRetried((value) => !value)}
          >
            Try again
          </button>
        </p>
      )}

      {operation && (
        <p className="install-progress">
          <LoaderCircle className="spin" size={16} />
          {operation.status === "failed"
            ? "Install failed."
            : (operation.message ?? "Downloading and verifying…")}
        </p>
      )}
      {operation?.status === "failed" && operation.message && (
        <details className="operation-error">
          <summary>View error log</summary>
          <pre>{operation.message}</pre>
        </details>
      )}

      <section className="panel">
        <div className="browse-toolbar">
          <label className="input-with-icon file-search">
            <Search size={16} />
            <input
              value={query}
              placeholder="Search Modrinth…"
              onChange={(event) => {
                const next = event.target.value;
                applyFilter(() => {
                  setQuery(next);
                  if (next.trim() && sort === "downloads") setSort("relevance");
                });
              }}
            />
          </label>
          <div className="browse-type-switcher" role="group">
            {allowedTypes.map((type) => (
              <button
                key={type}
                className={type === projectType ? "active" : ""}
                onClick={() => switchType(type)}
              >
                {typeLabels[type]}
              </button>
            ))}
          </div>
        </div>

        <div className="addon-actions">
          <label>
            Sort
            <select
              value={sort}
              onChange={(event) =>
                applyFilter(() =>
                  setSort(event.target.value as ModrinthSortIndex),
                )
              }
            >
              <option value="relevance">Relevance</option>
              <option value="downloads">Downloads</option>
              <option value="follows">Followers</option>
              <option value="newest">Newest</option>
              <option value="updated">Recently updated</option>
            </select>
          </label>
          <label>
            Minecraft
            <select
              value={gameVersion}
              onChange={(event) =>
                applyFilter(() => setGameVersion(event.target.value))
              }
            >
              <option value="">
                {tracksMoving ? "Any" : `Server (${server.config.version})`}
              </option>
              {releaseVersions.slice(0, 40).map((version) => (
                <option key={version} value={version}>
                  {version}
                </option>
              ))}
            </select>
          </label>
          {loading && <LoaderCircle className="spin" size={16} />}
        </div>

        {tracksMoving && (
          <p className="notice-banner">
            This server tracks {server.config.version}, so results are not
            filtered by Minecraft version. Pick one above to narrow them.
          </p>
        )}
      </section>

      {tags && tags.categories.length > 0 && (
        <details className="panel browse-filters">
          <summary>Categories</summary>
          <div className="browse-chip-row">
            {tags.categories.slice(0, 40).map((category) => {
              const active = categories.includes(category);
              return (
                <button
                  key={category}
                  className={`browse-chip${active ? " active" : ""}`}
                  onClick={() =>
                    applyFilter(() =>
                      setCategories((current) =>
                        active
                          ? current.filter((entry) => entry !== category)
                          : [...current, category].slice(0, 5),
                      ),
                    )
                  }
                >
                  {category}
                </button>
              );
            })}
          </div>
        </details>
      )}

      {hits.length === 0 && !loading && !error && !rateLimited ? (
        <div className="compact-empty">
          <PackageOpen size={26} />
          <p>No projects match this search.</p>
          {activeFilters && <p className="muted">{activeFilters}</p>}
          <button
            className="button ghost"
            onClick={() =>
              applyFilter(() => {
                setQuery("");
                setCategories([]);
                setGameVersion("");
              })
            }
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="browse-grid" aria-busy={loading}>
          {hits.map((hit) => (
            <article className="browse-card" key={hit.projectId}>
              <div className="browse-card-head">
                <span className="browse-card-icon" aria-hidden="true">
                  {hit.iconUrl ? (
                    <img
                      src={hit.iconUrl}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <Package size={20} />
                  )}
                </span>
                <div className="browse-card-body">
                  <strong>{hit.title}</strong>
                  <small className="muted">
                    {hit.author ? `by ${hit.author}` : "Unknown author"}
                  </small>
                </div>
              </div>
              <p className="browse-card-description">{hit.description}</p>
              <div className="browse-card-meta">
                <span>{hit.downloads.toLocaleString()} downloads</span>
                <span>
                  <Heart size={12} /> {hit.follows.toLocaleString()}
                </span>
              </div>
              <div className="browse-card-actions">
                <a
                  className="button ghost"
                  href={modrinthProjectUrl(hit.slug)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  <ExternalLink size={15} /> Modrinth
                </a>
                {canInstall && (
                  <button
                    className="button primary"
                    disabled={installBusy}
                    title={
                      installBusy
                        ? "Another install is still running"
                        : undefined
                    }
                    onClick={() => setSelected(hit)}
                  >
                    Install
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {result && hits.length > 0 && (
        <div className="browse-pagination">
          <button
            className="button ghost"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - pageSize))}
          >
            ← Previous
          </button>
          <span className="muted">
            {pageLabel(result.offset, hits.length, result.totalHits)}
          </span>
          <button
            className="button ghost"
            disabled={
              loading ||
              !hasNextPage(result.offset, hits.length, result.totalHits)
            }
            onClick={() => setOffset(offset + pageSize)}
          >
            Next →
          </button>
        </div>
      )}

      <InstallDialog
        server={server}
        project={selected}
        projectType={projectType}
        gameVersion={effectiveVersion}
        installedNames={installedNames}
        onClose={() => setSelected(null)}
        onInstalled={(started) => {
          setSelected(null);
          setInstalled("");
          setOperation(started);
        }}
      />
    </div>
  );
}
