export interface GitBranchInfo {
  name: string;
  current: boolean;
  remote: boolean;
  worktreePath: string | null;
  /** Occupancy only; another checkout's filesystem path stays privileged. */
  checkedOut?: boolean;
}

export interface WorkspaceEntry {
  path: string;
  kind: "file" | "directory";
}

export interface WorkspaceEntriesPage {
  /** Project-relative directory for a lazy listing; empty for root and search results. */
  directory: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}

/**
 * Bounds for the in-process, literal, case-insensitive project content
 * search. The runtime enforces every bound; the renderer only displays them.
 */
export const WORKSPACE_CONTENT_SEARCH_LIMITS = Object.freeze({
  queryCharacters: 200,
  defaultResults: 100,
  maxResults: 200,
  snippetCharacters: 240,
  maxFileBytes: 1024 * 1024,
  binarySniffBytes: 8 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  timeBudgetMs: 3_000,
});

/** Literal query: 1-200 characters, not only whitespace, no control characters. */
export function isWorkspaceContentSearchQuery(query: unknown): query is string {
  return typeof query === "string"
    && query.length >= 1
    && query.length <= WORKSPACE_CONTENT_SEARCH_LIMITS.queryCharacters
    && query.trim().length > 0
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(query);
}

export interface WorkspaceContentMatch {
  /** Project-relative path using forward slashes. */
  projectPath: string;
  /** 1-based line number, counted the same way as the file preview. */
  line: number;
  /** 1-based UTF-16 column of the first match on the line. */
  column: number;
  /** Bounded excerpt of the matching line around the match. */
  snippet: string;
}

export interface WorkspaceContentSearchPage {
  matches: WorkspaceContentMatch[];
  /** True when any result, byte, entry, depth, or time bound stopped the search. */
  truncated: boolean;
  /** A newer search from the same window replaced this one; it carries no matches. */
  cancelled?: true;
}

export interface WorkspaceFilePreview {
  path: string;
  content: string;
  truncated: boolean;
  language: string;
  contentDigest: string;
  modifiedAt: string;
  /** Ephemeral runtime-owned reference required to save this exact preview. */
  authorityRef?: string;
}

/**
 * Workspace edits travel as one authenticated WebSocket command. Keep the
 * editable body comfortably below the 256 KiB frame limit so JSON metadata,
 * UTF-8 expansion, and future bounded fields cannot turn a save into a
 * transport disconnect.
 */
export const MAX_WORKSPACE_FILE_EDIT_BYTES = 192 * 1024;

export interface ProjectAction {
  id: string;
  label: string;
  command: string;
  preview: boolean;
}
