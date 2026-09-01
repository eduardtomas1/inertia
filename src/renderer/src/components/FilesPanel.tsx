import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import clsx from "clsx";
import {
  AlertCircle,
  ChevronRight,
  Code2,
  Eye,
  ExternalLink,
  File,
  FileSearch,
  Folder,
  FolderTree,
  Pencil,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type {
  WorkspaceEntry,
  WorkspaceFilePreview,
} from "@shared/contracts";
import { sourceLanguageForFile } from "@shared/source-language";
import {
  flattenWorkspaceTree,
  isSafeWorkspaceEntryPath,
  sortWorkspaceEntries,
  workspaceParentPath,
  workspacePathName,
  workspaceTreeKeyboardAction,
  type WorkspaceTreeRow,
} from "../utils/workspaceTree";
import { highlightedSourceLines } from "../utils/sourceHighlighting";
import {
  markdownHeadingDomId,
  type MarkdownHeadingRequest,
} from "../utils/markdownHeading";
import {
  consumeWorkspaceFileOpenEdit,
  markWorkspaceFileSearchEdit,
  workspaceFileLocationLabel,
  type WorkspaceFileLocation,
} from "../utils/workspaceFileReference";
import { IconButton, LoadingMark } from "./ui";
import { FileEditorDialog } from "./FileEditorDialog";

type ResponseMarkdownComponent =
  typeof import("./ResponseMarkdown")["ResponseMarkdown"];
type ResponseMarkdownLoader = (attempt: number) => Promise<{
  ResponseMarkdown: ResponseMarkdownComponent;
}>;

const loadResponseMarkdown: ResponseMarkdownLoader = (_attempt) =>
  import("./ResponseMarkdown");
const FILE_PREVIEW_CLASS = "file-preview";
const FILE_ENTRY_CLASS = "file-entry";
const FILE_TREE_CLASS = "file-tree";
const FILE_PANEL_ERROR_CLASS = "file-panel-error";
const FILE_PREVIEW_TRUNCATED_CLASS = "file-preview-truncated";
const FILE_LIST_TRUNCATED_CLASS = "file-list-truncated";
const FILE_LANGUAGE_CLASS = "file-language";
const PANEL_LOADING_CLASS = "panel-loading";
const PANEL_EMPTY_CLASS = "panel-empty";
const PANEL_NOTICE_CLASS = "panel-notice";

class MarkdownPreviewErrorBoundary extends Component<{
  children: ReactNode;
  fallback: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function MarkdownPreviewSurface({
  loader = loadResponseMarkdown,
  loadingFallback,
  onShowSource,
  ...markdownProps
}: ComponentProps<ResponseMarkdownComponent> & {
  loader?: ResponseMarkdownLoader;
  loadingFallback: ReactNode;
  onShowSource: () => void;
}): React.JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const Renderer = useMemo(() => lazy(async () => ({
    default: (await loader(attempt)).ResponseMarkdown,
  })), [attempt, loader]);
  const failure = (
    <div className={`${FILE_PREVIEW_CLASS}-markdown-failure`} role="alert">
      <AlertCircle size={20} aria-hidden="true" />
      <strong>Preview failed</strong>
      <div>
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          <RefreshCw size={12} aria-hidden="true" />
          Retry
        </button>
        <button type="button" onClick={onShowSource}>
          <Code2 size={12} aria-hidden="true" />
          Source
        </button>
      </div>
    </div>
  );
  return (
    <MarkdownPreviewErrorBoundary key={attempt} fallback={failure}>
      <Suspense fallback={loadingFallback}>
        <Renderer {...markdownProps} />
      </Suspense>
    </MarkdownPreviewErrorBoundary>
  );
}

export interface WorkspaceEntriesPage {
  directory: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}

export type FilesPanelProps = {
  entries: WorkspaceEntry[];
  preview: WorkspaceFilePreview | null;
  selectedPath: string | null;
  projectRoot: string;
  projectId: string;
  conversationId?: string;
  selectedLocation?: WorkspaceFileLocation | null;
  selectedMarkdownHeading?: MarkdownHeadingRequest | null;
  loading?: boolean;
  previewLoading?: boolean;
  error?: string | null;
  previewError?: string | null;
  entriesTruncated?: boolean;
  onSelectFile: (
    path: string,
    location?: WorkspaceFileLocation,
    literalPath?: boolean,
    headingId?: string,
  ) => void;
  onOpenWorkspaceEntry?: (
    path: string,
    location?: WorkspaceFileLocation,
    literalPath?: boolean,
    headingId?: string,
  ) => void;
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
  error: string | null;
}

const EMPTY_SEARCH: SearchState = {
  entries: null,
  truncated: false,
  error: null,
};

const MAX_RENDERED_PREVIEW_LINES = 2_000;
export const MAX_RENDERED_MARKDOWN_PREVIEW_CHARACTERS = 100_000;

type FilePreviewView = "preview" | "source";

interface FilePreviewViewState {
  identity: string;
  view: FilePreviewView;
}

function safeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

function directoryChain(path: string): string[] {
  return path
    ? path.split("/").map((_, index, segments) =>
        segments.slice(0, index + 1).join("/"))
    : [];
}

function visibleDirectoryEntries(
  pages: ReadonlyMap<string, DirectoryPage>,
  selectedPath: string | null,
): Map<string, readonly WorkspaceEntry[]> {
  const entries = new Map<string, readonly WorkspaceEntry[]>(
    [...pages].map(([path, page]) => [path, page.entries]),
  );
  if (!selectedPath || !isSafeWorkspaceEntryPath(selectedPath)) return entries;
  for (const path of directoryChain(selectedPath)) {
    const parent = workspaceParentPath(path);
    const page = pages.get(parent);
    if (page?.truncated && !page.entries.some((entry) => entry.path === path)) {
      entries.set(parent, [...page.entries, {
        path,
        kind: path === selectedPath ? "file" : "directory",
      }]);
    }
  }
  return entries;
}

export function FilesPanel({
  entries,
  preview,
  selectedPath,
  projectRoot,
  projectId,
  conversationId,
  selectedLocation = null,
  selectedMarkdownHeading = null,
  loading = false,
  previewLoading = false,
  error = null,
  previewError = null,
  entriesTruncated = false,
  onSelectFile,
  onOpenWorkspaceEntry,
  onLoadEntries,
  onRefresh,
  onOpenFile,
  onSaveFile,
  canSaveFile,
}: FilesPanelProps): React.JSX.Element {
  const [fileExplorerOpen, setFileExplorerOpen] = useState(true);
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
  const [previewViewState, setPreviewViewState] =
    useState<FilePreviewViewState>({ identity: "", view: "preview" });
  const [pendingMarkdownHeading, setPendingMarkdownHeading] = useState<{
    path: string;
    id: string;
  } | null>(null);
  const consumedMarkdownHeadingRef = useRef<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const previewLineRefs = useRef(new Map<number, HTMLSpanElement>());
  const previewCodeRef = useRef<HTMLPreElement>(null);
  const previewMarkdownRef = useRef<HTMLDivElement>(null);
  const fileListRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchGeneration = useRef(0);
  const previousSelectedPathRef = useRef(selectedPath);
  const mounted = useRef(true);
  const previewEditable = preview !== null
    && !preview.truncated
    && canSaveFile?.(
      preview.path,
      preview.content,
      preview.contentDigest,
    ) === true;
  const previewLanguage = useMemo(
    () => preview
      ? sourceLanguageForFile(preview.path, preview.content)
      : null,
    [preview],
  );
  const previewLines = useMemo(
    () => preview?.content.split("\n") ?? [],
    [preview],
  );
  const markdownPreview = previewLanguage?.id === "markdown";
  const markdownPreviewBlockedReason = markdownPreview && preview
    ? preview.truncated
      ? "Full file needed."
      : preview.content.length > MAX_RENDERED_MARKDOWN_PREVIEW_CHARACTERS
        ? `Limit: ${MAX_RENDERED_MARKDOWN_PREVIEW_CHARACTERS.toLocaleString("en-US")} characters.`
        : previewLines.length > MAX_RENDERED_PREVIEW_LINES
          ? `Limit: ${MAX_RENDERED_PREVIEW_LINES.toLocaleString("en-US")} lines.`
          : null
    : null;
  const previewViewIdentity = preview
    ? [
        preview.path,
        preview.contentDigest,
        selectedLocation?.startLine ?? "",
        selectedLocation?.endLine ?? "",
      ].join("\0")
    : "";
  const defaultPreviewView: FilePreviewView = selectedLocation
    ? "source"
    : "preview";
  const requestedPreviewView = previewViewState.identity === previewViewIdentity
    ? previewViewState.view
    : defaultPreviewView;
  const renderedMarkdownPreview = markdownPreview
    && markdownPreviewBlockedReason === null
    && requestedPreviewView === "preview";
  const virtualizedSourcePreview = !renderedMarkdownPreview
    && previewLines.length > MAX_RENDERED_PREVIEW_LINES;
  const sourceVirtualizer = useVirtualizer({
    enabled: virtualizedSourcePreview,
    count: virtualizedSourcePreview ? previewLines.length : 0,
    getScrollElement: () => previewCodeRef.current,
    estimateSize: () => 17,
    measureElement: (element, entry) => Math.ceil(entry?.borderBoxSize[0]?.blockSize || element.getBoundingClientRect().height || 17),
    overscan: 24,
    initialRect: { width: 720, height: 480 },
    getItemKey: (index) => index,
  });
  const renderedPreviewLines = virtualizedSourcePreview
    ? sourceVirtualizer.getVirtualItems().map((item) => ({
        lineNumber: item.index + 1,
        text: previewLines[item.index] ?? "",
        virtual: item,
      }))
    : previewLines.map((text, index) => ({
        lineNumber: index + 1,
        text,
        virtual: null,
      }));
  const highlightedPreviewLines = useMemo(
    () => preview && previewLanguage && !renderedMarkdownPreview
      ? highlightedSourceLines(preview.content, previewLanguage)
      : null,
    [preview, previewLanguage, renderedMarkdownPreview],
  );
  const previewPath = preview?.path ?? null;
  const selectedMarkdownHeadingIdentity = selectedMarkdownHeading
    ? [
        selectedMarkdownHeading.requestId,
        selectedMarkdownHeading.path,
        selectedMarkdownHeading.headingId,
      ].join("\0")
    : null;
  const requestedMarkdownHeading = useMemo(() => (
    pendingMarkdownHeading ?? (
      selectedMarkdownHeading
      && selectedMarkdownHeadingIdentity
        !== consumedMarkdownHeadingRef.current
        ? {
            path: selectedMarkdownHeading.path,
            id: selectedMarkdownHeading.headingId,
          }
        : null
    )
  ), [
    pendingMarkdownHeading,
    selectedMarkdownHeading,
    selectedMarkdownHeadingIdentity,
  ]);

  useEffect(() => {
    if (
      !selectedMarkdownHeadingIdentity
      || selectedMarkdownHeadingIdentity === consumedMarkdownHeadingRef.current
      || selectedMarkdownHeading?.path !== previewPath
      || !markdownPreview
      || markdownPreviewBlockedReason !== null
    ) return;
    setPreviewViewState((current) => (
      current.identity === previewViewIdentity && current.view === "preview"
        ? current
        : { identity: previewViewIdentity, view: "preview" }
    ));
  }, [
    markdownPreview,
    markdownPreviewBlockedReason,
    previewPath,
    previewViewIdentity,
    selectedMarkdownHeading,
    selectedMarkdownHeadingIdentity,
  ]);

  const openMarkdownEntry = useCallback((
    path: string,
    location?: WorkspaceFileLocation,
    literalPath?: boolean,
    headingId?: string,
  ): void => {
    if (headingId && previewPath === path) {
      setPendingMarkdownHeading({ path, id: headingId });
      return;
    }
    setPendingMarkdownHeading(null);
    const openEntry = onOpenWorkspaceEntry ?? onSelectFile;
    if (headingId) openEntry(path, location, literalPath, headingId);
    else openEntry(path, location, literalPath);
  }, [onOpenWorkspaceEntry, onSelectFile, previewPath]);

  useEffect(() => {
    if (
      !requestedMarkdownHeading
      || requestedMarkdownHeading.path !== previewPath
      || !renderedMarkdownPreview
    ) return;
    const container = previewMarkdownRef.current;
    if (!container) return;
    let frame: number | null = null;
    const reveal = (): boolean => {
      const heading = [...container.querySelectorAll<HTMLElement>("[id]")]
        .find(({ id }) => id === markdownHeadingDomId(
          requestedMarkdownHeading.id,
        ));
      if (!heading) return false;
      heading.scrollIntoView({ block: "start", inline: "nearest" });
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      setPendingMarkdownHeading((current) =>
        current?.path === requestedMarkdownHeading.path
          && current.id === requestedMarkdownHeading.id
          ? null
          : current);
      if (
        selectedMarkdownHeadingIdentity
        && selectedMarkdownHeading?.path === requestedMarkdownHeading.path
        && selectedMarkdownHeading.headingId === requestedMarkdownHeading.id
      ) {
        consumedMarkdownHeadingRef.current = selectedMarkdownHeadingIdentity;
      }
      return true;
    };
    const scheduleReveal = (): void => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (reveal()) observer.disconnect();
      });
    };
    const observer = new MutationObserver(scheduleReveal);
    if (!reveal()) {
      observer.observe(container, { childList: true, subtree: true });
      scheduleReveal();
    }
    return () => {
      observer.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [
    previewPath,
    renderedMarkdownPreview,
    requestedMarkdownHeading,
    selectedMarkdownHeading,
    selectedMarkdownHeadingIdentity,
  ]);

  useEffect(() => {
    if (!previewPath || !selectedLocation || renderedMarkdownPreview) return;
    let frame: number | null = null;
    let observer: ResizeObserver | null = null;
    let userMoved = false;
    const reveal = (moveFocus: boolean, attempts = 0): void => {
      if (userMoved) return;
      if (virtualizedSourcePreview) {
        sourceVirtualizer.scrollToIndex(selectedLocation.startLine - 1, {
          align: "center",
        });
      }
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (userMoved) return;
        const line = previewLineRefs.current.get(selectedLocation.startLine);
        if (!line) {
          if (attempts < 3) reveal(moveFocus, attempts + 1);
          return;
        }
        line.scrollIntoView({ block: "center", inline: "nearest" });
        if (moveFocus) line.focus({ preventScroll: true });
      });
    };
    reveal(true);
    observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => reveal(false));
    const previewCode = previewCodeRef.current;
    const stopRecentering = (): void => {
      userMoved = true;
      observer?.disconnect();
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
        frame = null;
      }
    };
    if (previewCode) {
      observer?.observe(previewCode);
      previewCode.addEventListener("keydown", stopRecentering, { once: true });
      previewCode.addEventListener("pointerdown", stopRecentering, { once: true });
      previewCode.addEventListener("touchstart", stopRecentering, { once: true });
      previewCode.addEventListener("wheel", stopRecentering, { once: true });
    }
    return () => {
      observer?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      previewCode?.removeEventListener("keydown", stopRecentering);
      previewCode?.removeEventListener("pointerdown", stopRecentering);
      previewCode?.removeEventListener("touchstart", stopRecentering);
      previewCode?.removeEventListener("wheel", stopRecentering);
    };
  }, [
    previewPath,
    renderedMarkdownPreview,
    selectedLocation,
    sourceVirtualizer,
    virtualizedSourcePreview,
  ]);

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
      throw new Error("Folder left tree");
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
        safeError(loadError, "Load failed."),
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
    ++directoryGeneration.current;
    const next = freshWorkspaceDirectoryPages(entries, entriesTruncated);
    const rootDirectories = new Set(
      entries
        .filter(({ kind }) => kind === "directory")
        .map(({ path }) => path),
    );
    const selectedParent = entriesTruncated
      && selectedPath
      && isSafeWorkspaceEntryPath(selectedPath)
      ? workspaceParentPath(selectedPath)
      : "";
    const retainedExpandedPaths = new Set(
      [
        ...[...expandedPathsRef.current].filter((path) =>
          rootDirectories.has(path.split("/")[0] ?? "")
        ),
        ...directoryChain(selectedParent),
      ],
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
  }, [entries, entriesTruncated, loadDirectory, selectedPath]);

  const updateQuery = useCallback((value: string): void => {
    ++searchGeneration.current;
    markWorkspaceFileSearchEdit(projectId, conversationId);
    previousSelectedPathRef.current = selectedPath;
    setQuery(value);
    setSearch(EMPTY_SEARCH);
  }, [conversationId, projectId, selectedPath]);

  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) return;
    const generation = ++searchGeneration.current;
    setSearch({ entries: null, truncated: false, error: null });
    const timer = window.setTimeout(() => {
      void onLoadEntries({ query: normalized })
        .then((page) => {
          if (!mounted.current || searchGeneration.current !== generation) return;
          setSearch({
            entries: sortWorkspaceEntries(page.entries),
            truncated: page.truncated,
            error: null,
          });
        })
        .catch((searchError) => {
          if (!mounted.current || searchGeneration.current !== generation) return;
          setSearch({
            entries: [],
            truncated: false,
            error: safeError(searchError, "Search failed."),
          });
        });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [onLoadEntries, query]);

  const treeRows = useMemo(() => {
    return flattenWorkspaceTree(
      visibleDirectoryEntries(directoryPages, selectedPath),
      expandedPaths,
    );
  }, [directoryPages, expandedPaths, selectedPath]);

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
      setPendingMarkdownHeading(null);
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
      setPendingMarkdownHeading(null);
      onSelectFile(action.path);
    } else if (searchActive) {
      void revealSearchDirectory(action.path);
    } else {
      toggleDirectory(action.path);
    }
  };

  useEffect(() => {
    setFileExplorerOpen(true);
  }, [conversationId, projectId]);

  useEffect(() => {
    const openEdit = consumeWorkspaceFileOpenEdit(
      projectId,
      conversationId,
      selectedPath,
      preview?.path ?? (previewError ? selectedPath : null),
    );
    if (openEdit !== undefined) setFileExplorerOpen(false);
    if (
      openEdit
      || (
        previousSelectedPathRef.current === selectedPath
        && openEdit === undefined
      )
    ) {
      previousSelectedPathRef.current = selectedPath;
      return;
    }
    if (searchActive && selectedPath && isSafeWorkspaceEntryPath(selectedPath)) {
      if (search.entries === null) return;
      if (!visiblePaths.has(selectedPath)) updateQuery("");
    }
    previousSelectedPathRef.current = selectedPath;
  }, [
    conversationId,
    projectId,
    preview?.path,
    previewError,
    search.entries,
    searchActive,
    selectedPath,
    updateQuery,
    visiblePaths,
  ]);

  useEffect(() => {
    if (!selectedPath || !isSafeWorkspaceEntryPath(selectedPath)) return;
    const parent = workspaceParentPath(selectedPath);
    const chain = directoryChain(parent);
    updateExpandedPaths((current) => new Set([...current, ...chain]));
    for (const directory of chain) {
      if (!directoryPagesRef.current.has(directory)) void loadDirectory(directory);
    }
  }, [loadDirectory, selectedPath, updateExpandedPaths]);

  useEffect(() => {
    if (!selectedPath || !visiblePaths.has(selectedPath)) return;
    const reveal = (): void => itemRefs.current.get(selectedPath)
      ?.scrollIntoView({ block: "nearest" });
    reveal();
    const list = fileListRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    return () => observer.disconnect();
  }, [selectedPath, visiblePaths]);

  const treeBusy = loading
    || (searchActive && search.entries === null)
    || loadingDirectories.size > 0;
  const hasRootFailure = !searchActive && Boolean(error) && treeRows.length === 0;
  const hasSearchFailure = searchActive && Boolean(search.error);
  const showTreeLoading = searchActive
    ? search.entries === null
    : loading && treeRows.length === 0;
  const countLabel = searchActive
    ? `${search.entries?.length ?? 0} results`
    : `${treeRows.length} visible`;

  return (
    <section className="files-panel" aria-label="Project files" aria-busy={treeBusy}>
      <div className={clsx(
        "files-layout",
        fileExplorerOpen && "is-explorer-open",
      )}>
        <div className="file-search-wrap" hidden={!fileExplorerOpen}>
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            ref={searchInputRef}
            value={query}
            aria-label="Search files"
            placeholder="Search"
            onChange={(event) => updateQuery(event.currentTarget.value)}
          />
          {query && (
            <IconButton
              label="Clear search"
              onClick={() => {
                updateQuery("");
                window.requestAnimationFrame(() => searchInputRef.current?.focus());
              }}
            >
              <X size={14} />
            </IconButton>
          )}
          {onRefresh && (
            <IconButton label="Refresh" onClick={onRefresh} disabled={loading}>
              {loading
                ? <LoadingMark label="Refreshing" />
                : <RefreshCw size={14} />}
            </IconButton>
          )}
        </div>

        <div
          className={`${FILE_ENTRY_CLASS}-list`}
          hidden={!fileExplorerOpen}
          ref={fileListRef}
          role="tree"
          aria-label={searchActive ? "Search results" : "Files"}
          aria-busy={treeBusy}
        >
          {showTreeLoading ? (
            <div className={PANEL_LOADING_CLASS} role="status">
              <LoadingMark label={searchActive ? "Searching" : "Loading"} />
              <span>{searchActive ? "Searching…" : "Loading…"}</span>
            </div>
          ) : hasRootFailure || hasSearchFailure ? (
            <div className={`${PANEL_EMPTY_CLASS} compact ${FILE_PANEL_ERROR_CLASS}`} role="alert">
              <AlertCircle size={20} aria-hidden="true" />
              <p>{searchActive ? search.error : error}</p>
            </div>
          ) : rows.length === 0 ? (
            <div className={`${PANEL_EMPTY_CLASS} compact`}>
              <FileSearch size={20} aria-hidden="true" />
              <p>{searchActive ? "No matches." : "Empty project."}</p>
            </div>
          ) : rows.map((row) => {
            const { entry } = row;
            const name = workspacePathName(entry.path);
            const entryLanguage = entry.kind === "file"
              ? sourceLanguageForFile(entry.path)
              : null;
            const parent = searchActive ? workspaceParentPath(entry.path) : "";
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
              <div className={`${FILE_TREE_CLASS}-row-group`} key={entry.path}>
                <button
                  type="button"
                  role="treeitem"
                  className={clsx(
                    FILE_ENTRY_CLASS,
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
                  data-language-family={entryLanguage?.family}
                >
                  {entry.kind === "directory" && !searchActive ? (
                    <ChevronRight
                      className={`${FILE_TREE_CLASS}-chevron`}
                      size={13}
                      aria-hidden="true"
                    />
                  ) : (
                    <span className={`${FILE_TREE_CLASS}-chevron-spacer`} aria-hidden="true" />
                  )}
                  {entry.kind === "directory"
                    ? <Folder size={15} aria-hidden="true" />
                    : (
                        <File
                          className={`${FILE_LANGUAGE_CLASS}-icon`}
                          size={15}
                          aria-hidden="true"
                        />
                      )}
                  <span className={`${FILE_ENTRY_CLASS}-copy`}>
                    <span className={`${FILE_ENTRY_CLASS}-name`}>{name}</span>
                    {parent && <span className={`${FILE_ENTRY_CLASS}-path`}>{parent}</span>}
                  </span>
                </button>
                {showDirectoryStatus && (
                  <div
                    className={clsx(`${FILE_TREE_CLASS}-status`, directoryError && "is-error")}
                    role={directoryError ? "alert" : "status"}
                    style={{
                      "--file-tree-indent": `${Math.min(row.depth * 13, 104)}px`,
                    } as React.CSSProperties}
                  >
                    {directoryLoading
                      ? `Loading ${name}…`
                      : directoryError
                        ? `${directoryError} Enter retries.`
                        : directoryPage?.truncated
                          ? `More in ${name}.`
                          : `${name} is empty.`}
                  </div>
                )}
              </div>
            );
          })}
          {!searchActive && error && treeRows.length > 0 && (
            <p className={`${PANEL_NOTICE_CLASS} ${FILE_PANEL_ERROR_CLASS}`} role="alert">{error}</p>
          )}
          {!searchActive && directoryPages.get("")?.truncated && (
            <p className={`${PANEL_NOTICE_CLASS} ${FILE_LIST_TRUNCATED_CLASS}`}>
              More files.
            </p>
          )}
          {searchActive && search.truncated && (
            <p className={`${PANEL_NOTICE_CLASS} ${FILE_LIST_TRUNCATED_CLASS}`}>
              Refine for more.
            </p>
          )}
        </div>

        <div className={FILE_PREVIEW_CLASS}>
          <header className={`${FILE_PREVIEW_CLASS}-header`}>
            <div
              className={`${FILE_PREVIEW_CLASS}-identity`}
              title={preview?.path ?? selectedPath ?? "Project files"}
              role="status"
              aria-live="polite"
            >
              <strong>{preview || selectedPath
                ? workspacePathName(preview?.path ?? selectedPath ?? "")
                : "Project files"}</strong>
              <span>{preview?.path ?? selectedPath ?? countLabel}</span>
            </div>
            <div className={`${FILE_PREVIEW_CLASS}-metadata`}>
              {previewLanguage && (
                <span
                  className={FILE_LANGUAGE_CLASS}
                  data-language-family={previewLanguage.family}
                  title={`${previewLanguage.label} recognized locally`}
                >
                  {previewLanguage.label}
                </span>
              )}
              {selectedLocation && (
                <span className="file-location">
                  {workspaceFileLocationLabel(selectedLocation)}
                </span>
              )}
            </div>
            <div className={`${FILE_PREVIEW_CLASS}-actions`}>
              {markdownPreview && preview && (
                <div
                  className={`${FILE_PREVIEW_CLASS}-view-toggle`}
                  role="group"
                  aria-label="Markdown"
                >
                  <button
                    type="button"
                    aria-pressed={renderedMarkdownPreview}
                    disabled={markdownPreviewBlockedReason !== null}
                    title={markdownPreviewBlockedReason ?? "Preview"}
                    onClick={() => setPreviewViewState({
                      identity: previewViewIdentity,
                      view: "preview",
                    })}
                  >
                    <Eye size={11} aria-hidden="true" />
                    <span>Preview</span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={!renderedMarkdownPreview}
                    title="Source"
                    onClick={() => setPreviewViewState({
                      identity: previewViewIdentity,
                      view: "source",
                    })}
                  >
                    <Code2 size={11} aria-hidden="true" />
                    <span>Source</span>
                  </button>
                </div>
              )}
              {preview && onSaveFile && (
                <IconButton
                  label={previewEditable
                    ? `Edit ${preview.path}`
                    : `${preview.path} is too large to edit`}
                  disabled={!previewEditable}
                  onClick={() => setEditingFile(preview)}
                >
                  <Pencil size={14} />
                </IconButton>
              )}
              {preview && onOpenFile && (
                <IconButton
                  label="Open file"
                  onClick={() => onOpenFile(preview.path)}
                >
                  <ExternalLink size={14} />
                </IconButton>
              )}
              <IconButton
                label={fileExplorerOpen
                  ? "Hide file explorer"
                  : "Show file explorer"}
                aria-pressed={fileExplorerOpen}
                className="file-explorer-toggle"
                onClick={() => setFileExplorerOpen(!fileExplorerOpen)}
              >
                <FolderTree size={14} />
              </IconButton>
            </div>
          </header>
          {previewLoading && selectedPath ? (
            <div className={PANEL_LOADING_CLASS} role="status" aria-live="polite">
              <LoadingMark label="Loading" />
              <span>Loading {workspacePathName(selectedPath)}…</span>
            </div>
          ) : previewError && selectedPath ? (
            <div className={`${PANEL_EMPTY_CLASS} ${FILE_PANEL_ERROR_CLASS}`} role="alert">
              <AlertCircle size={22} aria-hidden="true" />
              <h3>Preview failed: {workspacePathName(selectedPath)}</h3>
              <p>{previewError}</p>
            </div>
          ) : preview ? (
            <>
              {renderedMarkdownPreview ? (
                <div
                  ref={previewMarkdownRef}
                  className={`${FILE_PREVIEW_CLASS}-markdown`}
                  role="document"
                  tabIndex={0}
                  aria-label={`Preview of ${preview.path}`}
                >
                  <MarkdownPreviewSurface
                    key={previewViewIdentity}
                    content={preview.content}
                    projectRoot={projectRoot}
                    projectId={projectId}
                    conversationId={conversationId}
                    markdownBasePath={workspaceParentPath(preview.path)}
                    defaultCodeWrap
                    onOpenProjectFile={openMarkdownEntry}
                    onShowSource={() => setPreviewViewState({
                      identity: previewViewIdentity,
                      view: "source",
                    })}
                    loadingFallback={(
                      <div className={PANEL_LOADING_CLASS} role="status">
                        <LoadingMark label="Rendering" />
                        <span>Rendering…</span>
                      </div>
                    )}
                  />
                </div>
              ) : (
                <pre ref={previewCodeRef} className={`${FILE_PREVIEW_CLASS}-code`} tabIndex={0} aria-label={`Contents of ${preview.path}`}>
                  <code
                    className={clsx(
                      highlightedPreviewLines && "hljs",
                      virtualizedSourcePreview && "is-virtualized",
                    )}
                    style={virtualizedSourcePreview
                      ? { height: `${sourceVirtualizer.getTotalSize()}px` }
                      : undefined}
                  >
                    {renderedPreviewLines.map(({ lineNumber, text, virtual }) => {
                      const referenced = selectedLocation !== null
                        && lineNumber >= selectedLocation.startLine
                        && lineNumber <= selectedLocation.endLine;
                      const referenceStart = selectedLocation?.startLine === lineNumber;
                      const highlightedLine = highlightedPreviewLines?.[lineNumber - 1];
                      return (
                        <span
                          className={clsx(
                            `${FILE_PREVIEW_CLASS}-line`,
                            referenced && "is-referenced",
                          )}
                          data-source-line={lineNumber}
                          data-index={virtual?.index}
                          key={lineNumber}
                          ref={(node) => {
                            if (node) previewLineRefs.current.set(lineNumber, node);
                            else previewLineRefs.current.delete(lineNumber);
                            if (node && virtual) sourceVirtualizer.measureElement(node);
                          }}
                          tabIndex={referenceStart ? -1 : undefined}
                          aria-label={referenceStart && selectedLocation
                            ? `${workspaceFileLocationLabel(selectedLocation)} in ${preview.path}`
                            : undefined}
                          style={virtual
                            ? {
                                transform: `translateY(${virtual.start}px)`,
                              } as CSSProperties
                            : undefined}
                        >
                          <span className={`${FILE_PREVIEW_CLASS}-line-number`} aria-hidden="true">{lineNumber}</span>
                          {highlightedLine !== undefined
                            ? (
                                <span
                                  dangerouslySetInnerHTML={{
                                    __html: highlightedLine || " ",
                                  }}
                                />
                              )
                            : <span>{text || " "}</span>}
                        </span>
                      );
                    })}
                  </code>
                </pre>
              )}
              {markdownPreviewBlockedReason && (
                <p className={`${PANEL_NOTICE_CLASS} ${FILE_PREVIEW_TRUNCATED_CLASS}`} role="status">
                  {markdownPreviewBlockedReason} Use Source.
                </p>
              )}
              {preview.truncated && (
                <p className={`${PANEL_NOTICE_CLASS} ${FILE_PREVIEW_TRUNCATED_CLASS}`}>
                  Beginning only.
                </p>
              )}
            </>
          ) : (
            <div className={PANEL_EMPTY_CLASS}>
              <FileSearch size={22} aria-hidden="true" />
              <p>Select a file.</p>
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
