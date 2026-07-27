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
}

export interface ProjectAction {
  id: string;
  label: string;
  command: string;
  preview: boolean;
}
