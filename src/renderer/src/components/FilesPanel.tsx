import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import clsx from "clsx";
import {
  AlertCircle,
  ChevronRight,
  ExternalLink,
  File,
  FileSearch,
  Folder,
  Pencil,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type {
  WorkspaceEntry,
  WorkspaceFilePreview,
} from "@shared/contracts";
import {
  flattenWorkspaceTree,
  isSafeWorkspaceEntryPath,
  sortWorkspaceEntries,
  workspaceParentPath,
  workspacePathName,
  workspaceTreeKeyboardAction,
  type WorkspaceTreeRow,
} from "../utils/workspaceTree";
import { IconButton, LoadingMark } from "./ui";
import { FileEditorDialog } from "./FileEditorDialog";

export interface WorkspaceEntriesPage {
  directory: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}

export type FilesPanelProps = {
  entries: WorkspaceEntry[];
  preview: WorkspaceFilePreview | null;
  selectedPath: string | null;
  loading?: boolean;
  previewLoading?: boolean;
  error?: string | null;
  previewError?: string | null;
  entriesTruncated?: boolean;
  onSelectFile: (path: string) => void;
  onLoadEntries: (request: {
    directory?: string;
    query?: string;
  }) => Promise<WorkspaceEntriesPage>;
  onRefresh?: () => void;
  onOpenFile?: (path: string) => void;
  onSaveFile?: (
    path: string,
    content: string,
    expectedDigest: string,
  ) => Promise<WorkspaceFilePreview>;
  canSaveFile?: (
    path: string,
    content: string,
    expectedDigest: string,
  ) => boolean;
};

export interface DirectoryPage {
  entries: WorkspaceEntry[];
  truncated: boolean;
}

export function freshWorkspaceDirectoryPages(
  entries: WorkspaceEntry[],
  truncated: boolean,
): Map<string, DirectoryPage> {
  return new Map([
    ["", { entries: sortWorkspaceEntries(entries), truncated }],
  ]);
}

interface SearchState {
  entries: WorkspaceEntry[] | null;
  truncated: boolean;
  loading: boolean;
  error: string | null;
}

const EMPTY_SEARCH: SearchState = {
  entries: null,
  truncated: false,
  loading: false,
  error: null,
};

function safeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

function parentLabel(path: string): string {
  return workspaceParentPath(path);
}

function directoryChain(path: string): string[] {
  const segments = path.split("/");
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

export function FilesPanel({
  entries,
  preview,
  selectedPath,
  loading = false,
  previewLoading = false,
  error = null,
  previewError = null,
  entriesTruncated = false,
  onSelectFile,
  onLoadEntries,
  onRefresh,
  onOpenFile,
  onSaveFile,
  canSaveFile,
}: FilesPanelProps): React.JSX.Element {
  const [directoryPages, setDirectoryPages] = useState(
    () => freshWorkspaceDirectoryPages(entries, entriesTruncated),
  );
  const directoryPagesRef = useRef(directoryPages);
  const rootInputRef = useRef({ entries, entriesTruncated });
  const directoryGeneration = useRef(0);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const expandedPathsRef = useRef(expandedPaths);
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(() => new Set());
  const [directoryErrors, setDirectoryErrors] = useState<Map<string, string>>(() => new Map());
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>(EMPTY_SEARCH);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [editingFile, setEditingFile] =
    useState<WorkspaceFilePreview | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchGeneration = useRef(0);
  const mounted = useRef(true);
  const previewEditable = preview !== null
    && !preview.truncated
    && canSaveFile?.(
      preview.path,
      preview.content,
      preview.contentDigest,
    ) === true;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const updateExpandedPaths = useCallback((
    update: (current: Set<string>) => Set<string>,
  ): void => {
    setExpandedPaths((current) => {
      const next = update(current);
      expandedPathsRef.current = next;
      return next;
    });
  }, []);

  const storePage = useCallback((path: string, page: WorkspaceEntriesPage): void => {
    if (page.directory !== path) {
      throw new Error("The workspace returned a folder outside the requested tree location.");
    }
    const next = new Map(directoryPagesRef.current);
    next.set(path, {
      entries: sortWorkspaceEntries(page.entries),
      truncated: page.truncated,
    });
    directoryPagesRef.current = next;
    setDirectoryPages(next);
  }, []);

  const loadDirectory = useCallback(async (path: string): Promise<void> => {
    if (!isSafeWorkspaceEntryPath(path)) return;
    const generation = directoryGeneration.current;
    setLoadingDirectories((current) => new Set(current).add(path));
    setDirectoryErrors((current) => {
      const next = new Map(current);
      next.delete(path);
      return next;
    });
    try {
      const page = await onLoadEntries({ directory: path });
      if (!mounted.current || directoryGeneration.current !== generation) return;
      storePage(path, page);
    } catch (loadError) {
      if (!mounted.current || directoryGeneration.current !== generation) return;
      setDirectoryErrors((current) => new Map(current).set(
        path,
        safeError(loadError, "This folder could not be loaded."),
      ));
    } finally {
      if (mounted.current && directoryGeneration.current === generation) {
        setLoadingDirectories((current) => {
          const next = new Set(current);
          next.delete(path);
          return next;
        });
      }
    }
  }, [onLoadEntries, storePage]);

  useEffect(() => {
    if (
      rootInputRef.current.entries === entries
      && rootInputRef.current.entriesTruncated === entriesTruncated
    ) return;
    rootInputRef.current = { entries, entriesTruncated };
    directoryGeneration.current += 1;
    const next = freshWorkspaceDirectoryPages(entries, entriesTruncated);
    const rootDirectories = new Set(
      entries
        .filter(({ kind }) => kind === "directory")
        .map(({ path }) => path),
    );
    const retainedExpandedPaths = new Set(
      [...expandedPathsRef.current].filter((path) =>
        rootDirectories.has(path.split("/")[0] ?? "")
      ),
    );
    expandedPathsRef.current = retainedExpandedPaths;
    directoryPagesRef.current = next;
    setDirectoryPages(next);
    setExpandedPaths(retainedExpandedPaths);
    setLoadingDirectories(new Set());
    setDirectoryErrors(new Map());
    for (const path of retainedExpandedPaths) {
      void loadDirectory(path);
    }
  }, [entries, entriesTruncated, loadDirectory]);

  const updateQuery = (value: string): void => {
    searchGeneration.current += 1;
    setQuery(value);
    if (!value.trim()) setSearch(EMPTY_SEARCH);
  };

  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) return;
    const generation = ++searchGeneration.current;
    setSearch({ entries: null, truncated: false, loading: true, error: null });
    const timer = window.setTimeout(() => {
      void onLoadEntries({ query: normalized })
        .then((page) => {
          if (!mounted.current || searchGeneration.current !== generation) return;
          setSearch({
            entries: sortWorkspaceEntries(page.entries),
            truncated: page.truncated,
            loading: false,
            error: null,
          });
        })
        .catch((searchError) => {
          if (!mounted.current || searchGeneration.current !== generation) return;
          setSearch({
            entries: [],
            truncated: false,
            loading: false,
            error: safeError(searchError, "The project search could not be completed."),
          });
        });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [onLoadEntries, query]);

  const treeRows = useMemo(() => {
    const pages = new Map<string, readonly WorkspaceEntry[]>();
    for (const [path, page] of directoryPages) pages.set(path, page.entries);
    return flattenWorkspaceTree(pages, expandedPaths);
  }, [directoryPages, expandedPaths]);

  const searchRows = useMemo<WorkspaceTreeRow[]>(() => (
    (search.entries ?? []).map((entry) => ({
      entry,
      depth: 1,
      parentPath: "",
      expanded: false,
    }))
  ), [search.entries]);
  const searchActive = Boolean(query.trim());
  const rows = searchActive ? searchRows : treeRows;
  const visiblePaths = useMemo(
    () => new Set(rows.map(({ entry }) => entry.path)),
    [rows],
  );
  const rovingPath = focusedPath && visiblePaths.has(focusedPath)
    ? focusedPath
    : selectedPath && visiblePaths.has(selectedPath)
      ? selectedPath
      : rows[0]?.entry.path ?? null;

  const focusItem = (path: string): void => {
    setFocusedPath(path);
    window.requestAnimationFrame(() => itemRefs.current.get(path)?.focus());
  };

  const toggleDirectory = (path: string): void => {
    if (directoryErrors.has(path) && expandedPaths.has(path)) {
      void loadDirectory(path);
      return;
    }
    if (expandedPaths.has(path)) {
      updateExpandedPaths((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      return;
    }
    updateExpandedPaths((current) => new Set(current).add(path));
    if (!directoryPagesRef.current.has(path)) void loadDirectory(path);
  };

  const revealSearchDirectory = async (path: string): Promise<void> => {
    if (!isSafeWorkspaceEntryPath(path)) return;
    updateQuery("");
    const chain = directoryChain(path);
    updateExpandedPaths((current) => new Set([...current, ...chain]));
    for (const directory of chain) {
      if (directoryPagesRef.current.has(directory)) continue;
      await loadDirectory(directory);
    }
    if (!mounted.current) return;
    focusItem(path);
  };

  const activateRow = (row: WorkspaceTreeRow): void => {
    setFocusedPath(row.entry.path);
    if (row.entry.kind === "file") {
      onSelectFile(row.entry.path);
    } else if (searchActive) {
      void revealSearchDirectory(row.entry.path);
    } else {
      toggleDirectory(row.entry.path);
    }
  };

  const onTreeKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    row: WorkspaceTreeRow,
  ): void => {
    // Native buttons synthesize one click for Enter/Space. Handling the same
    // activation in keydown can race the search-result rerender and toggle the
    // newly revealed directory closed again on slower platforms.
    if (event.key === "Enter" || event.key === " ") return;
    const action = workspaceTreeKeyboardAction(event.key, row.entry.path, rows);
    if (action.type === "none") return;
    event.preventDefault();
    if (action.type === "focus") {
      focusItem(action.path);
    } else if (action.type === "open") {
      onSelectFile(action.path);
    } else if (searchActive) {
      void revealSearchDirectory(action.path);
    } else {
      toggleDirectory(action.path);
    }
  };

  const treeBusy = loading
    || search.loading
    || loadingDirectories.size > 0;
  const hasRootFailure = !searchActive && Boolean(error) && treeRows.length === 0;
  const hasSearchFailure = searchActive && Boolean(search.error);
  const showTreeLoading = searchActive
    ? search.loading || search.entries === null
    : loading && treeRows.length === 0;
  const countLabel = searchActive
    ? `${search.entries?.length ?? 0} results`
    : `${treeRows.length} visible`;

  return (
    <section className="files-panel" aria-label="Project files" aria-busy={treeBusy}>
      <header className="panel-toolbar files-toolbar">
        <div className="panel-heading">
          <Folder size={17} aria-hidden="true" />
          <div className="panel-heading-copy">
            <h2>Files</h2>
            <span>{countLabel}</span>
          </div>
        </div>
        {onRefresh && (
          <IconButton label="Refresh files" onClick={onRefresh} disabled={loading}>
            {loading ? <LoadingMark label="Refreshing files" /> : <RefreshCw size={15} />}
          </IconButton>
        )}
      </header>

      <div className="file-search-wrap">
        <Search size={15} aria-hidden="true" />
        <input
          type="search"
          ref={searchInputRef}
          value={query}
          aria-label="Search project files"
          placeholder="Search files"
          onChange={(event) => updateQuery(event.currentTarget.value)}
        />
        {query && (
          <IconButton
            label="Clear file search"
            onClick={() => {
              updateQuery("");
              window.requestAnimationFrame(() => searchInputRef.current?.focus());
            }}
          >
            <X size={14} />
          </IconButton>
        )}
      </div>

      <div className="files-layout">
        <div
          className="file-entry-list"
          role="tree"
          aria-label={searchActive ? "Workspace file search results" : "Workspace files"}
          aria-busy={treeBusy}
        >
          {showTreeLoading ? (
            <div className="panel-loading" role="status">
              <LoadingMark label={searchActive ? "Searching files" : "Loading files"} />
              <span>{searchActive ? "Searching files…" : "Loading files…"}</span>
            </div>
          ) : hasRootFailure || hasSearchFailure ? (
            <div className="panel-empty compact file-panel-error" role="alert">
              <AlertCircle size={20} aria-hidden="true" />
              <p>{searchActive ? search.error : error}</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="panel-empty compact">
              <FileSearch size={20} aria-hidden="true" />
              <p>{searchActive ? "No files match this search." : "This project folder is empty."}</p>
            </div>
          ) : rows.map((row) => {
            const { entry } = row;
            const name = workspacePathName(entry.path);
            const parent = searchActive ? parentLabel(entry.path) : "";
            const directoryPage = entry.kind === "directory"
              ? directoryPages.get(entry.path)
              : undefined;
            const directoryLoading = loadingDirectories.has(entry.path);
            const directoryError = directoryErrors.get(entry.path);
            const showDirectoryStatus = !searchActive
              && entry.kind === "directory"
              && row.expanded
              && (
                directoryLoading
                || Boolean(directoryError)
                || (directoryPage !== undefined && directoryPage.entries.length === 0)
                || directoryPage?.truncated
              );
            return (
              <div className="file-tree-row-group" key={entry.path}>
                <button
                  type="button"
                  role="treeitem"
                  className={clsx(
                    "file-entry",
                    `is-${entry.kind}`,
                    selectedPath === entry.path && "is-selected",
                  )}
                  aria-level={row.depth}
                  aria-expanded={entry.kind === "directory" && !searchActive ? row.expanded : undefined}
                  aria-selected={entry.kind === "file" && selectedPath === entry.path}
                  aria-current={entry.kind === "file" && selectedPath === entry.path ? "true" : undefined}
                  onClick={() => activateRow(row)}
                  onKeyDown={(event) => onTreeKeyDown(event, row)}
                  ref={(node) => {
                    if (node) itemRefs.current.set(entry.path, node);
                    else itemRefs.current.delete(entry.path);
                  }}
                  tabIndex={entry.path === rovingPath ? 0 : -1}
                  style={{
                    "--file-tree-indent": `${Math.min((row.depth - 1) * 13, 91)}px`,
                  } as React.CSSProperties}
                  title={entry.path}
                >
                  {entry.kind === "directory" && !searchActive ? (
                    <ChevronRight
                      className="file-tree-chevron"
                      size={13}
                      aria-hidden="true"
                    />
                  ) : (
                    <span className="file-tree-chevron-spacer" aria-hidden="true" />
                  )}
                  {entry.kind === "directory"
                    ? <Folder size={15} aria-hidden="true" />
                    : <File size={15} aria-hidden="true" />}
                  <span className="file-entry-copy">
                    <span className="file-entry-name">{name}</span>
                    {parent && <span className="file-entry-path">{parent}</span>}
                  </span>
                </button>
                {showDirectoryStatus && (
                  <div
                    className={clsx("file-tree-status", directoryError && "is-error")}
                    role={directoryError ? "alert" : "status"}
                    style={{
                      "--file-tree-indent": `${Math.min(row.depth * 13, 104)}px`,
                    } as React.CSSProperties}
                  >
                    {directoryLoading
                      ? `Loading ${name}…`
                      : directoryError
                        ? `${directoryError} Press Enter to retry.`
                        : directoryPage?.entries.length === 0
                          ? `${name} is empty.`
                          : `Showing the first ${directoryPage?.entries.length ?? 0} entries in ${name}.`}
                  </div>
                )}
              </div>
            );
          })}
          {!searchActive && error && treeRows.length > 0 && (
            <p className="panel-notice file-panel-error" role="alert">{error}</p>
          )}
          {!searchActive && directoryPages.get("")?.truncated && (
            <p className="panel-notice file-list-truncated">
              Showing the first {directoryPages.get("")?.entries.length ?? 0} items in the project root.
            </p>
          )}
          {searchActive && search.truncated && (
            <p className="panel-notice file-list-truncated">
              Refine your search to see results beyond this limit.
            </p>
          )}
        </div>

        <div className="file-preview" aria-live="polite">
          {previewLoading && selectedPath ? (
            <div className="panel-loading">
              <LoadingMark label="Loading file" />
              <span>Loading {workspacePathName(selectedPath)}…</span>
            </div>
          ) : previewError && selectedPath ? (
            <div className="panel-empty file-panel-error" role="alert">
              <AlertCircle size={22} aria-hidden="true" />
              <h3>Could not preview {workspacePathName(selectedPath)}</h3>
              <p>{previewError}</p>
            </div>
          ) : preview ? (
            <>
              <header className="file-preview-header">
                <div title={preview.path}>
                  <strong>{workspacePathName(preview.path)}</strong>
                  <span>{preview.path}</span>
                </div>
                <span className="file-language">{preview.language || "text"}</span>
                {onSaveFile && (
                  <IconButton
                    label={previewEditable
                      ? `Edit ${preview.path} in Inertia`
                      : `${preview.path} is too large to edit safely in Inertia`}
                    disabled={!previewEditable}
                    onClick={() => setEditingFile(preview)}
                  >
                    <Pencil size={14} />
                  </IconButton>
                )}
                {onOpenFile && (
                  <IconButton
                    label="Open file in default editor"
                    onClick={() => onOpenFile(preview.path)}
                  >
                    <ExternalLink size={14} />
                  </IconButton>
                )}
              </header>
              <pre className="file-preview-code" tabIndex={0} aria-label={`Contents of ${preview.path}`}>
                <code>
                  {preview.content.split("\n").map((line, index) => (
                    <span className="file-preview-line" key={index}>
                      <span className="file-preview-line-number" aria-hidden="true">{index + 1}</span>
                      <span>{line || " "}</span>
                    </span>
                  ))}
                </code>
              </pre>
              {preview.truncated && (
                <p className="panel-notice file-preview-truncated">
                  This preview shows only the beginning of the file.
                </p>
              )}
            </>
          ) : (
            <div className="panel-empty">
              <FileSearch size={22} aria-hidden="true" />
              <h3>Select a file</h3>
              <p>Choose a file to preview its contents without leaving the workspace.</p>
            </div>
          )}
        </div>
      </div>
      {editingFile && onSaveFile && (
        <FileEditorDialog
          file={editingFile}
          canSave={canSaveFile ?? (() => false)}
          onClose={() => setEditingFile(null)}
          onSave={onSaveFile}
        />
      )}
    </section>
  );
}
