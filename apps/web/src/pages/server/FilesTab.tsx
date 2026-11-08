import {
  ChevronRight,
  Download,
  FileCode2,
  FilePlus2,
  FileQuestion,
  FileUp,
  Folder,
  FolderOpen,
  FolderPlus,
  Home,
  LoaderCircle,
  MoreVertical,
  RefreshCw,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
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

function parentPath(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

type DialogState =
  | { kind: "create-file" | "create-folder" }
  | { kind: "rename"; entry: ServerFileEntry }
  | { kind: "move"; entry: ServerFileEntry }
  | { kind: "delete"; entry: ServerFileEntry }
  | null;

type DeferredAction = (() => void | Promise<void>) | null;

export function FilesTab({ server }: { server: ServerSummary }) {
  const [currentPath, setCurrentPath] = useState("");
  const [entries, setEntries] = useState<ServerFileEntry[]>([]);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<ServerFileEntry[]>([]);
  const [openDocument, setOpenDocument] = useState<ServerFileDocument | null>(
    null,
  );
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [menuPath, setMenuPath] = useState("");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [dialogValue, setDialogValue] = useState("");
  const [movePath, setMovePath] = useState("");
  const [moveEntries, setMoveEntries] = useState<ServerFileEntry[]>([]);
  const [dirtyAction, setDirtyAction] = useState<DeferredAction>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const latestFolderRequest = useRef(0);
  const dirty = openDocument !== null && draft !== openDocument.content;

  const loadFolder = useCallback(
    async (path: string) => {
      // Rapid folder navigation: only the most recently requested folder may
      // paint, regardless of response order.
      const request = ++latestFolderRequest.current;
      setLoading(true);
      try {
        const found = await api<ServerFileEntry[]>(
          `/api/servers/${server.id}/files?${queryPath(path)}`,
        );
        if (request !== latestFolderRequest.current) return;
        setEntries(found);
        setCurrentPath(path);
        setError("");
      } catch (caught) {
        if (request !== latestFolderRequest.current) return;
        setError(
          caught instanceof Error ? caught.message : "Unable to load files",
        );
      } finally {
        if (request === latestFolderRequest.current) setLoading(false);
      }
    },
    [server.id],
  );

  useEffect(() => void loadFolder(""), [loadFolder, server.id]);

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  useEffect(() => {
    if (!menuPath) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuPath("");
    };
    globalThis.document.addEventListener("mousedown", close);
    return () => globalThis.document.removeEventListener("mousedown", close);
  }, [menuPath]);

  const refreshSearch = useCallback(async () => {
    const query = search.trim();
    if (!query) return;
    setSearchResults(
      await api<ServerFileEntry[]>(
        `/api/servers/${server.id}/files/search?q=${encodeURIComponent(query)}`,
      ),
    );
  }, [search, server.id]);

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
      } catch (caught) {
        if (!cancelled)
          setError(
            caught instanceof Error ? caught.message : "Unable to search files",
          );
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

  function afterDirty(action: () => void | Promise<void>) {
    if (dirty) setDirtyAction(() => action);
    else void action();
  }

  async function openFile(entry: ServerFileEntry) {
    if (!entry.editable) return;
    setOpening(entry.path);
    try {
      const next = await api<ServerFileDocument>(
        `/api/servers/${server.id}/files/content?${queryPath(entry.path)}`,
      );
      setOpenDocument(next);
      setDraft(next.content);
      setError("");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to open file",
      );
    } finally {
      setOpening("");
    }
  }

  function openEntry(entry: ServerFileEntry) {
    if (entry.type === "directory") {
      afterDirty(() => {
        setSearch("");
        setOpenDocument(null);
        setDraft("");
        return loadFolder(entry.path);
      });
    } else if (entry.editable) {
      afterDirty(() => openFile(entry));
    }
  }

  async function save(): Promise<boolean> {
    if (!openDocument || !dirty) return true;
    setBusy(true);
    try {
      const saved = await api<ServerFileDocument>(
        `/api/servers/${server.id}/files/content`,
        {
          method: "PUT",
          ...jsonBody({
            path: openDocument.path,
            content: draft,
            expectedModifiedAt: openDocument.modifiedAt,
          }),
        },
      );
      setOpenDocument(saved);
      setDraft(saved.content);
      setError("");
      await loadFolder(currentPath);
      return true;
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to save file",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  function editorKeys(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
    }
  }

  function openDialog(next: Exclude<DialogState, null>) {
    setMenuPath("");
    setDialog(next);
    if (next.kind === "create-file" || next.kind === "create-folder") {
      setDialogValue("");
    } else if (
      next.kind === "rename" ||
      next.kind === "move" ||
      next.kind === "delete"
    ) {
      setDialogValue(next.entry.name);
      if (next.kind === "move") {
        setMovePath(currentPath);
        void loadMoveFolder(currentPath);
      }
    }
  }

  async function loadMoveFolder(path: string) {
    try {
      const listed = await api<ServerFileEntry[]>(
        `/api/servers/${server.id}/files?${queryPath(path)}`,
      );
      setMovePath(path);
      setMoveEntries(listed.filter((entry) => entry.type === "directory"));
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to load folders",
      );
    }
  }

  async function refreshViews() {
    await loadFolder(currentPath);
    await refreshSearch().catch(() => undefined);
  }

  async function createEntry() {
    if (
      !dialog ||
      (dialog.kind !== "create-file" && dialog.kind !== "create-folder")
    )
      return;
    setBusy(true);
    try {
      await api(`/api/servers/${server.id}/files`, {
        method: "POST",
        ...jsonBody({
          parentPath: currentPath,
          name: dialogValue,
          type: dialog.kind === "create-folder" ? "directory" : "file",
        }),
      });
      setNotice(`${dialogValue} created.`);
      setDialog(null);
      await refreshViews();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to create entry",
      );
    } finally {
      setBusy(false);
    }
  }

  async function moveOrRename() {
    if (!dialog || (dialog.kind !== "rename" && dialog.kind !== "move")) return;
    const entry = dialog.entry;
    const destination =
      dialog.kind === "rename"
        ? [parentPath(entry.path), dialogValue].filter(Boolean).join("/")
        : [movePath, entry.name].filter(Boolean).join("/");
    setBusy(true);
    try {
      const moved = await api<ServerFileEntry>(
        `/api/servers/${server.id}/files`,
        {
          method: "PATCH",
          ...jsonBody({ path: entry.path, destinationPath: destination }),
        },
      );
      if (
        openDocument &&
        (openDocument.path === entry.path ||
          openDocument.path.startsWith(`${entry.path}/`))
      ) {
        const suffix = openDocument.path.slice(entry.path.length);
        setOpenDocument({ ...openDocument, path: moved.path + suffix });
      }
      setNotice(`${entry.name} moved to ${moved.path}.`);
      setDialog(null);
      await refreshViews();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to move entry",
      );
    } finally {
      setBusy(false);
    }
  }

  async function deleteEntry() {
    if (dialog?.kind !== "delete") return;
    const entry = dialog.entry;
    setBusy(true);
    try {
      const query = new URLSearchParams({
        path: entry.path,
        expectedModifiedAt: entry.modifiedAt,
      });
      await api(`/api/servers/${server.id}/files?${query}`, {
        method: "DELETE",
      });
      if (
        openDocument &&
        (openDocument.path === entry.path ||
          openDocument.path.startsWith(`${entry.path}/`))
      ) {
        setOpenDocument(null);
        setDraft("");
      }
      setNotice(`${entry.name} deleted.`);
      setDialog(null);
      await refreshViews();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to delete entry",
      );
    } finally {
      setBusy(false);
    }
  }

  async function upload(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    try {
      const body = new FormData();
      files.forEach((file) => body.append("file", file));
      await api(
        `/api/servers/${server.id}/files/upload?${queryPath(currentPath)}`,
        {
          method: "POST",
          body,
        },
      );
      setNotice(
        `${files.length} file${files.length === 1 ? "" : "s"} uploaded.`,
      );
      if (input.current) input.current.value = "";
      await refreshViews();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to upload files",
      );
    } finally {
      setBusy(false);
    }
  }

  const visibleEntries = search.trim() ? searchResults : entries;

  return (
    <div
      className={`tab-stack file-drop-surface${dragging ? " is-dragging" : ""}`}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void upload(Array.from(event.dataTransfer.files));
      }}
    >
      {dragging && (
        <div className="file-drop-overlay" aria-hidden="true">
          <FileUp size={24} />
          Drop files into /{currentPath}
        </div>
      )}
      {error && <ErrorBanner message={error} />}
      {notice && (
        <p className="notice-banner" aria-live="polite">
          {notice}
        </p>
      )}
      <div className="panel files-toolbar">
        <div>
          <h2>Server files</h2>
          <p>Manage everything under this server&apos;s data directory.</p>
        </div>
        <div className="file-toolbar-actions">
          <label className="input-with-icon file-search">
            <Search size={16} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search files…"
              aria-label="Search files"
            />
          </label>
          <input
            ref={input}
            hidden
            type="file"
            multiple
            onChange={(event) =>
              event.target.files && void upload(Array.from(event.target.files))
            }
          />
          <button
            className="button ghost"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            <FileUp size={16} /> Upload
          </button>
          <button
            className="icon-button"
            aria-label="New file"
            title="New file"
            onClick={() => openDialog({ kind: "create-file" })}
          >
            <FilePlus2 size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="New folder"
            title="New folder"
            onClick={() => openDialog({ kind: "create-folder" })}
          >
            <FolderPlus size={16} />
          </button>
        </div>
      </div>

      <div className="file-workspace">
        <section className="panel explorer-panel">
          <div className="explorer-heading">
            <div className="breadcrumbs" aria-label="Current folder">
              <button
                aria-label="Server data"
                title="Server data"
                onClick={() =>
                  afterDirty(() => {
                    setSearch("");
                    setOpenDocument(null);
                    setDraft("");
                    return loadFolder("");
                  })
                }
              >
                <Home size={15} />
              </button>
              {breadcrumbs.map((crumb) => (
                <span key={crumb.path}>
                  <ChevronRight size={13} />
                  <button
                    onClick={() =>
                      afterDirty(() => {
                        setSearch("");
                        setOpenDocument(null);
                        setDraft("");
                        return loadFolder(crumb.path);
                      })
                    }
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
            </div>
            <button
              className="icon-button"
              aria-label="Refresh folder"
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
                <div
                  className={`file-manager-row ${openDocument?.path === entry.path ? "selected" : ""}`}
                  key={entry.path}
                >
                  <button
                    className="explorer-row"
                    disabled={opening === entry.path}
                    onClick={() => openEntry(entry)}
                    title={entry.path}
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
                          : `${entry.size === null ? "—" : formatBytes(entry.size)} · ${entry.editable ? "Editable" : "Downloadable"}`}
                      </small>
                    </span>
                    {entry.type === "directory" && <ChevronRight size={15} />}
                  </button>
                  <div
                    className="file-row-menu"
                    ref={menuPath === entry.path ? menuRef : undefined}
                  >
                    <button
                      className="icon-button"
                      aria-label={`Actions for ${entry.name}`}
                      aria-haspopup="menu"
                      aria-expanded={menuPath === entry.path}
                      onClick={() =>
                        setMenuPath(menuPath === entry.path ? "" : entry.path)
                      }
                    >
                      <MoreVertical size={16} />
                    </button>
                    {menuPath === entry.path && (
                      <div
                        className="action-menu"
                        role="menu"
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setMenuPath("");
                        }}
                      >
                        {entry.type === "file" && (
                          <a
                            role="menuitem"
                            href={`/api/servers/${server.id}/files/download?${queryPath(entry.path)}`}
                          >
                            <Download size={14} /> Download
                          </a>
                        )}
                        <button
                          role="menuitem"
                          onClick={() => openDialog({ kind: "rename", entry })}
                        >
                          Rename
                        </button>
                        <button
                          role="menuitem"
                          onClick={() => openDialog({ kind: "move", entry })}
                        >
                          Move
                        </button>
                        <button
                          role="menuitem"
                          className="danger"
                          onClick={() =>
                            afterDirty(() =>
                              openDialog({ kind: "delete", entry }),
                            )
                          }
                        >
                          <Trash2 size={14} /> Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="editor-panel">
          {openDocument ? (
            <>
              <div className="editor-toolbar">
                <div>
                  <strong>{basename(openDocument.path)}</strong>
                  <small>{openDocument.path}</small>
                </div>
                <span className={dirty ? "unsaved-state" : "saved-state"}>
                  {dirty ? "Unsaved" : "Saved"}
                </span>
                <button
                  className="button primary"
                  disabled={!dirty || busy}
                  onClick={() => void save()}
                >
                  {busy ? (
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
                aria-label={`Editing ${openDocument.path}`}
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
                Text configuration opens here. Every regular file can be
                downloaded or managed from its action menu.
              </p>
            </div>
          )}
        </section>
      </div>

      <dialog
        open={dialog !== null}
        className="confirmation-dialog file-dialog"
        aria-labelledby="file-dialog-title"
        onCancel={(event) => {
          event.preventDefault();
          setDialog(null);
        }}
      >
        {dialog && (
          <div className="dialog-card">
            <h2 id="file-dialog-title">
              {dialog.kind === "create-file"
                ? "New file"
                : dialog.kind === "create-folder"
                  ? "New folder"
                  : dialog.kind === "rename"
                    ? `Rename ${dialog.entry.name}`
                    : dialog.kind === "move"
                      ? `Move ${dialog.entry.name}`
                      : dialog.kind === "delete"
                        ? `Delete ${dialog.entry.name}?`
                        : "Manage file"}
            </h2>
            {dialog.kind === "delete" ? (
              <p>
                {dialog.entry.type === "directory"
                  ? `This permanently deletes ${dialog.entry.path} and everything inside it.`
                  : `This permanently deletes ${dialog.entry.path}.`}
              </p>
            ) : dialog.kind === "move" ? (
              <>
                <p>
                  Choose the destination folder. Existing files are never
                  overwritten.
                </p>
                <div className="folder-picker">
                  <div className="breadcrumbs">
                    <button onClick={() => void loadMoveFolder("")}>
                      <Home size={15} />
                    </button>
                    {movePath
                      .split("/")
                      .filter(Boolean)
                      .map((part, index, all) => {
                        const target = all.slice(0, index + 1).join("/");
                        return (
                          <span key={target}>
                            <ChevronRight size={13} />
                            <button onClick={() => void loadMoveFolder(target)}>
                              {part}
                            </button>
                          </span>
                        );
                      })}
                  </div>
                  <div className="folder-picker-list">
                    {moveEntries.map((entry) => (
                      <button
                        key={entry.path}
                        className="explorer-row"
                        onClick={() => void loadMoveFolder(entry.path)}
                      >
                        <Folder size={16} />
                        <span>
                          <strong>{entry.name}</strong>
                          <small>{entry.path}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                  <small>Destination: /{movePath || ""}</small>
                </div>
              </>
            ) : (
              <label>
                {dialog.kind === "rename" ? "New name" : "Name"}
                <input
                  autoFocus
                  value={dialogValue}
                  onChange={(event) => setDialogValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter")
                      void (dialog.kind.startsWith("create")
                        ? createEntry()
                        : moveOrRename());
                  }}
                />
              </label>
            )}
            <div className="dialog-actions">
              <button className="button ghost" onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button
                className={
                  dialog.kind === "delete" ? "button danger" : "button primary"
                }
                disabled={
                  busy ||
                  ((dialog.kind === "create-file" ||
                    dialog.kind === "create-folder" ||
                    dialog.kind === "rename") &&
                    !dialogValue.trim())
                }
                onClick={() =>
                  void (dialog.kind === "delete"
                    ? deleteEntry()
                    : dialog.kind === "move" || dialog.kind === "rename"
                      ? moveOrRename()
                      : createEntry())
                }
              >
                {busy ? <LoaderCircle className="spin" size={15} /> : null}
                {dialog.kind === "delete"
                  ? "Delete permanently"
                  : dialog.kind === "move"
                    ? "Move here"
                    : dialog.kind === "rename"
                      ? "Rename"
                      : "Create"}
              </button>
            </div>
          </div>
        )}
      </dialog>

      <dialog
        open={dirtyAction !== null}
        className="confirmation-dialog"
        aria-labelledby="dirty-dialog-title"
        onCancel={(event) => {
          event.preventDefault();
          setDirtyAction(null);
        }}
      >
        <div className="dialog-card">
          <h2 id="dirty-dialog-title">Unsaved changes</h2>
          <p>Save this file before continuing, discard the draft, or cancel.</p>
          <div className="dialog-actions">
            <button
              className="button ghost"
              onClick={() => setDirtyAction(null)}
            >
              Cancel
            </button>
            <button
              className="button danger-outline"
              onClick={() => {
                const action = dirtyAction;
                setDirtyAction(null);
                setOpenDocument(null);
                setDraft("");
                if (action) void action();
              }}
            >
              Discard
            </button>
            <button
              className="button primary"
              onClick={() =>
                void (async () => {
                  const action = dirtyAction;
                  if (await save()) {
                    setDirtyAction(null);
                    if (action) await action();
                  }
                })()
              }
            >
              Save and continue
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
