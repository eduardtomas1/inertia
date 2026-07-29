export interface GitBranchInfo {
  name: string;
  current: boolean;
  remote: boolean;
  worktreePath: string | null;
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

export interface WorkspaceFilePreview {
  path: string;
  content: string;
  truncated: boolean;
  language: string;
  contentDigest: string;
  modifiedAt: string;
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
