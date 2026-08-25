import { useEffect, useRef, useState } from "react";
import { ExternalLink, LoaderCircle, Package } from "lucide-react";
import {
  modrinthProjectUrl,
  type MarketplaceProjectType,
  type ModrinthSearchHit,
  type ModrinthVersionSummary,
  type Operation,
  type ServerSummary,
} from "@mineserver/shared";
import { api, formatBytes, jsonBody } from "../../api";
import { ErrorBanner } from "../../components/Layout";
import {
  describeVersionChannel,
  isVersionInstalled,
  pickDefaultVersion,
  primaryFile,
  requiredDependencies,
} from "../../modrinth";

export function InstallDialog({
  server,
  project,
  projectType,
  gameVersion,
  installedNames,
  onClose,
  onInstalled,
}: {
  server: ServerSummary;
  project: ModrinthSearchHit | null;
  projectType: MarketplaceProjectType;
  gameVersion: string;
  installedNames: Set<string>;
  onClose(): void;
  onInstalled(operation: Operation): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [versions, setVersions] = useState<ModrinthVersionSummary[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [withDependencies, setWithDependencies] = useState(true);
  const [error, setError] = useState("");

  const open = project !== null;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const slug = project?.slug ?? "";

  useEffect(() => {
    if (!slug) {
      setVersions([]);
      setSelected("");
      setError("");
      setWithDependencies(true);
      return;
    }
    // A slow response for a project the user has already navigated away from
    // must not land on the dialog and swap in the wrong version list.
    let cancelled = false;
    setLoading(true);
    setError("");
    setVersions([]);
    setSelected("");
    void api<{ versions: ModrinthVersionSummary[] }>(
      `/api/modrinth/projects/${encodeURIComponent(slug)}/versions` +
        `?serverType=${server.config.type}` +
        `&gameVersion=${encodeURIComponent(gameVersion)}` +
        `&projectType=${projectType}`,
    )
      .then((response) => {
        if (cancelled) return;
        setVersions(response.versions);
        setSelected(pickDefaultVersion(response.versions)?.id ?? "");
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(
          caught instanceof Error
            ? caught.message
            : "Unable to load versions for this project",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, projectType, gameVersion, server.config.type]);

  const chosen = versions.find((version) => version.id === selected) ?? null;
  const description = project?.description ?? "";
  const chosenFile = chosen ? primaryFile(chosen) : null;
  const required = chosen ? requiredDependencies(chosen) : [];
  const unidentified = required.some((entry) => entry.projectId === null);
  const alreadyInstalled = isVersionInstalled(
    chosenFile?.filename ?? null,
    installedNames,
  );
  // A project with no stable build is common on a brand-new Minecraft version,
  // so say so rather than hiding the prereleases.
  const noRelease =
    versions.length > 0 &&
    !versions.some((version) => version.versionType === "release");

  async function install() {
    if (!chosen) return;
    setInstalling(true);
    setError("");
    try {
      const operation = await api<Operation>(
        `/api/servers/${server.id}/modrinth/install`,
        {
          method: "POST",
          ...jsonBody({
            versionId: chosen.id,
            projectType,
            includeRequiredDependencies: withDependencies,
          }),
        },
      );
      onInstalled(operation);
    } catch (error) {
      // Keep the dialog open so another version can be picked.
      setError(
        error instanceof Error ? error.message : "Unable to start the install",
      );
    } finally {
      setInstalling(false);
    }
  }

  return (
    <dialog
      ref={ref}
      className="confirmation-dialog install-dialog"
      aria-labelledby="install-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog-card">
        <div className="install-dialog-header">
          <span className="browse-card-icon" aria-hidden="true">
            {project?.iconUrl ? (
              <img
                src={project.iconUrl}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <Package size={20} />
            )}
          </span>
          <div>
            <h2 id="install-dialog-title">{project?.title ?? ""}</h2>
            <small className="muted">
              {project?.author ? `by ${project.author}` : "Unknown author"}
            </small>
          </div>
          <a
            className="button ghost"
            href={modrinthProjectUrl(slug)}
            target="_blank"
            rel="noreferrer noopener"
          >
            <ExternalLink size={15} /> Modrinth
          </a>
        </div>

        <p className="muted install-dialog-description">{description}</p>

        {error && <ErrorBanner message={error} />}

        {noRelease && (
          <p className="notice-banner">
            This project has no stable release for your server. The newest
            pre-release is selected instead.
          </p>
        )}

        {loading ? (
          <p className="muted">
            <LoaderCircle className="spin" size={15} /> Loading versions…
          </p>
        ) : versions.length === 0 ? (
          <p className="muted">
            No compatible versions for {server.config.type.toLowerCase()}
            {gameVersion === "LATEST" || gameVersion === "SNAPSHOT"
              ? ""
              : ` ${gameVersion}`}
            .
          </p>
        ) : (
          <>
            <h3 className="install-dialog-subhead">Version</h3>
            <ul className="explorer-list install-version-list">
              {versions.map((version) => {
                const file = primaryFile(version);
                const installed = isVersionInstalled(
                  file?.filename ?? null,
                  installedNames,
                );
                return (
                  <li key={version.id}>
                    <button
                      className={`explorer-row${
                        version.id === selected ? " selected" : ""
                      }`}
                      onClick={() => setSelected(version.id)}
                      disabled={installed}
                    >
                      <span className="install-version-name">
                        <strong>{version.versionNumber}</strong>
                        <span className={`channel-pill ${version.versionType}`}>
                          {describeVersionChannel(version.versionType)}
                        </span>
                        {installed && (
                          <span className="enabled-pill">
                            Already installed
                          </span>
                        )}
                      </span>
                      <small className="muted">
                        {version.loaders.join(", ")} ·{" "}
                        {version.gameVersions.slice(0, 4).join(", ")}
                        {file ? ` · ${formatBytes(file.size)}` : ""}
                      </small>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {required.length > 0 && (
          <>
            <h3 className="install-dialog-subhead">Required dependencies</h3>
            <label className="install-dependency-toggle">
              <input
                type="checkbox"
                checked={withDependencies}
                onChange={(event) => setWithDependencies(event.target.checked)}
              />
              Also install {required.length} required{" "}
              {required.length === 1 ? "dependency" : "dependencies"}
            </label>
            <ul className="file-list">
              {required.map((entry, index) => (
                <li
                  className="file-row"
                  key={entry.projectId ?? entry.versionId ?? index}
                >
                  <Package size={15} className="file-icon" />
                  <span>
                    {entry.title ??
                      entry.projectId ??
                      "Unidentified dependency"}
                  </span>
                </li>
              ))}
            </ul>
            {unidentified && (
              <p className="notice-banner">
                One dependency could not be identified. The install may still
                need a manual step.
              </p>
            )}
          </>
        )}

        <div className="dialog-actions">
          <button className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            onClick={() => void install()}
            disabled={!chosen || installing || alreadyInstalled}
          >
            {installing ? (
              <>
                <LoaderCircle className="spin" size={15} /> Starting…
              </>
            ) : alreadyInstalled ? (
              "Already installed"
            ) : (
              "Install"
            )}
          </button>
        </div>
      </div>
    </dialog>
  );
}
