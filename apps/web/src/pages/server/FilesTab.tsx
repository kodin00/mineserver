import {
  ChevronRight,
  FileCode2,
  FileQuestion,
  Folder,
  FolderOpen,
  Home,
  LoaderCircle,
  RefreshCw,
  Save,
  Search,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from "react";
import type {
  ServerFileDocument,
  ServerFileEntry,
  ServerSummary,
} from "@mineserver/shared";
import { api, formatBytes, jsonBody } from "../../api";
import { ErrorBanner } from "../../components/Layout";

function queryPath(path: string): string {
  return new URLSearchParams({ path }).toString();
}

export function FilesTab({ server }: { server: ServerSummary }) {
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<ServerFileEntry[]>([]);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<ServerFileEntry[]>([]);
  const [document, setDocument] = useState<ServerFileDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dirty = document !== null && draft !== document.content;

  const loadFolder = useCallback(
    async (path: string) => {
      setLoading(true);
      try {
        setEntries(
          await api<ServerFileEntry[]>(
            `/api/servers/${server.id}/files?${queryPath(path)}`,
          ),
        );
        setCurrentPath(path);
        setError("");
      } catch (error) {
        setError(
          error instanceof Error ? error.message : "Unable to load files",
        );
      } finally {
        setLoading(false);
      }
    },
    [server.id],
  );

  useEffect(() => {
    void loadFolder("");
  }, [loadFolder, server.id]);

  useEffect(() => {
    const query = search.trim();
    if (!query) {
      setSearchResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const results = await api<ServerFileEntry[]>(
          `/api/servers/${server.id}/files/search?q=${encodeURIComponent(query)}`,
        );
        if (!cancelled) {
          setSearchResults(results);
          setError("");
        }
      } catch (error) {
        if (!cancelled) {
          setError(
            error instanceof Error ? error.message : "Unable to search files",
          );
        }
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [search, server.id]);

  const breadcrumbs = useMemo(() => {
    const segments = currentPath.split("/").filter(Boolean);
    return segments.map((name, index) => ({
      name,
      path: segments.slice(0, index + 1).join("/"),
    }));
  }, [currentPath]);

  async function openFile(entry: ServerFileEntry) {
    if (!entry.editable) return;
    if (dirty && !confirm("Discard your unsaved file changes?")) return;
    setOpening(entry.path);
    try {
      const next = await api<ServerFileDocument>(
        `/api/servers/${server.id}/files/content?${queryPath(entry.path)}`,
      );
      setDocument(next);
      setDraft(next.content);
      setError("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to open file");
    } finally {
      setOpening("");
    }
  }

  function openEntry(entry: ServerFileEntry) {
    if (entry.type === "directory") {
      setSearch("");
      void loadFolder(entry.path);
    } else {
      void openFile(entry);
    }
  }

  async function save() {
    if (!document || !dirty) return;
    setSaving(true);
    try {
      const saved = await api<ServerFileDocument>(
        `/api/servers/${server.id}/files/content`,
        {
          method: "PUT",
          ...jsonBody({
            path: document.path,
            content: draft,
            expectedModifiedAt: document.modifiedAt,
          }),
        },
      );
      setDocument(saved);
      setDraft(saved.content);
      setError("");
      await loadFolder(currentPath);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to save file");
    } finally {
      setSaving(false);
    }
  }

  function editorKeys(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
    }
  }

  const visibleEntries = search.trim() ? searchResults : entries;

  return (
    <div className="tab-stack">
      {error && <ErrorBanner message={error} />}
      <div className="panel files-toolbar">
        <div>
          <h2>Server files</h2>
          <p>Browse the server data and edit supported text configuration.</p>
        </div>
        <label className="input-with-icon file-search">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search files…"
            aria-label="Search files"
          />
        </label>
      </div>

      <div className="file-workspace">
        <section className="panel explorer-panel">
          <div className="explorer-heading">
            <div className="breadcrumbs" aria-label="Current folder">
              <button
                title="Server data"
                onClick={() => {
                  setSearch("");
                  void loadFolder("");
                }}
              >
                <Home size={15} />
              </button>
              {breadcrumbs.map((crumb) => (
                <span key={crumb.path}>
                  <ChevronRight size={13} />
                  <button
                    onClick={() => {
                      setSearch("");
                      void loadFolder(crumb.path);
                    }}
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
            </div>
            <button
              className="icon-button"
              title="Refresh folder"
              onClick={() => void loadFolder(currentPath)}
            >
              <RefreshCw size={16} />
            </button>
          </div>

          <div className="explorer-list">
            {loading && !search.trim() ? (
              <div className="explorer-empty">
                <LoaderCircle className="spin" size={22} /> Loading files…
              </div>
            ) : visibleEntries.length === 0 ? (
              <div className="explorer-empty">
                <FileQuestion size={23} />
                {search.trim() ? "No matching files" : "This folder is empty"}
              </div>
            ) : (
              visibleEntries.map((entry) => (
                <button
                  className={`explorer-row ${
                    document?.path === entry.path ? "selected" : ""
                  }`}
                  key={entry.path}
                  disabled={
                    opening === entry.path ||
                    (entry.type === "file" && !entry.editable)
                  }
                  onClick={() => openEntry(entry)}
                  title={
                    entry.type === "file" && !entry.editable
                      ? "This file can be viewed in the tree but not edited"
                      : entry.path
                  }
                >
                  <span className="explorer-icon">
                    {opening === entry.path ? (
                      <LoaderCircle className="spin" size={17} />
                    ) : entry.type === "directory" ? (
                      <Folder size={17} />
                    ) : (
                      <FileCode2 size={17} />
                    )}
                  </span>
                  <span>
                    <strong>{entry.name}</strong>
                    <small>
                      {entry.type === "directory"
                        ? entry.path
                        : `${entry.size === null ? "—" : formatBytes(entry.size)} · ${
                            entry.editable ? "Editable" : "Read only"
                          }`}
                    </small>
                  </span>
                  {entry.type === "directory" && <ChevronRight size={15} />}
                </button>
              ))
            )}
          </div>
        </section>

        <section className="editor-panel">
          {document ? (
            <>
              <div className="editor-toolbar">
                <div>
                  <strong>{document.path.split("/").at(-1)}</strong>
                  <small>{document.path}</small>
                </div>
                <span className={dirty ? "unsaved-state" : "saved-state"}>
                  {dirty ? "Unsaved" : "Saved"}
                </span>
                <button
                  className="button primary"
                  disabled={!dirty || saving}
                  onClick={() => void save()}
                >
                  {saving ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <Save size={16} />
                  )}
                  Save
                </button>
              </div>
              <textarea
                className="file-editor"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={editorKeys}
                spellCheck={false}
                aria-label={`Editing ${document.path}`}
              />
              <div className="editor-status">
                UTF-8 · {draft.split("\n").length} lines · Ctrl/⌘ + S to save
              </div>
            </>
          ) : (
            <div className="editor-empty">
              <span>
                <FolderOpen size={28} />
              </span>
              <strong>Select an editable file</strong>
              <p>
                TOML, YAML, JSON, properties, and other text configuration
                formats open here.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
