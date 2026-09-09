import type { ChangedFile, WorkspaceGitSnapshot } from "@shared/contracts";
import { isSafeWorkspaceEntryPath, workspaceParentPath } from "./workspaceTree";

// UI projection bounds are independent of the runtime's process/output bounds.
// No content reads, diff requests, filesystem walks or per-row Git commands.
export const FILE_GIT_LIMITS = { repositories: 128, files: 4_000, ancestors: 32 } as const;
export interface FileGitDecoration { label: string; mark: string; kind: "modified" | "added" | "deleted" | "conflict" }
export interface FileTreeGitIndex {
  files: ReadonlyMap<string, FileGitDecoration>;
  directories: ReadonlySet<string>;
  notice: string;
}
export interface FileTreeGitState { snapshot: WorkspaceGitSnapshot | null; loading: boolean; unavailable: boolean }

function decoration(file: ChangedFile): FileGitDecoration | null {
  const codes = `${file.indexStatus}${file.worktreeStatus}`;
  if (codes.includes("U") || codes === "AA" || codes === "DD" || file.status === "unmerged") {
    return { label: "Merge conflict", mark: "!", kind: "conflict" };
  }
  if (file.untracked || file.status === "untracked") return { label: "Untracked", mark: "?", kind: "added" };
  const kinds: Record<string, Omit<FileGitDecoration, "label"> & { label: string }> = {
    modified: { label: "Modified", mark: "M", kind: "modified" },
    added: { label: "Added", mark: "A", kind: "added" },
    deleted: { label: "Deleted", mark: "D", kind: "deleted" },
    renamed: { label: "Renamed", mark: "R", kind: "modified" },
    copied: { label: "Copied", mark: "C", kind: "added" },
    "type-changed": { label: "Type changed", mark: "T", kind: "modified" },
  };
  const result = kinds[file.status];
  if (!result) return null;
  const staging = file.staged && file.unstaged ? "staged and unstaged" : file.staged ? "staged" : "unstaged";
  return { ...result, label: `${result.label} · ${staging}` };
}

export function buildFileTreeGitIndex(state?: FileTreeGitState): FileTreeGitIndex {
  const files = new Map<string, FileGitDecoration>();
  const directories = new Set<string>();
  if (!state || state.unavailable) return { files, directories, notice: "Git status unavailable. Files without badges are not confirmed clean." };
  if (state.loading || !state.snapshot) return { files, directories, notice: "Checking Git changes…" };
  const snapshot = state.snapshot;
  let limited = snapshot.partial || snapshot.truncated || snapshot.repositories.length > FILE_GIT_LIMITS.repositories;
  const repositories = snapshot.repositories.slice(0, FILE_GIT_LIMITS.repositories)
    .filter(({ repositoryPath }) => repositoryPath === "." || isSafeWorkspaceEntryPath(repositoryPath));
  // Deepest roots own their files. Never leak a parent repository's status into
  // a nested repository, including one whose own status could not be read.
  repositories.sort((a, b) => b.repositoryPath.length - a.repositoryPath.length);
  const roots = new Set(repositories.map(({ repositoryPath }) => repositoryPath === "." ? "" : repositoryPath));
  const owner = (path: string): string => {
    let parent = workspaceParentPath(path);
    while (parent) {
      if (roots.has(parent)) return parent;
      parent = workspaceParentPath(parent);
    }
    return "";
  };
  let inspected = 0;
  for (const repository of repositories) {
    if (repository.state !== "ready") { limited = true; continue; }
    limited ||= repository.truncated;
    const root = repository.repositoryPath === "." ? "" : repository.repositoryPath;
    for (const file of repository.files) {
      if (++inspected > FILE_GIT_LIMITS.files) { limited = true; break; }
      if (!isSafeWorkspaceEntryPath(file.path)) { limited = true; continue; }
      const path = root ? `${root}/${file.path}` : file.path;
      if (path.length > 4_096 || owner(path) !== root) continue;
      const status = decoration(file);
      if (!status) { limited = true; continue; }
      files.set(path, status);
      let parent = workspaceParentPath(path); let depth = 0;
      while (parent && depth++ < FILE_GIT_LIMITS.ancestors) {
        directories.add(parent); parent = workspaceParentPath(parent);
      }
      if (parent) limited = true;
    }
    if (inspected > FILE_GIT_LIMITS.files) break;
  }
  const notice = limited ? "Git status is partial. Files without badges may still have changes."
    : repositories.length === 0 ? "No Git repository detected. File browsing remains available."
    : "Git changes from the latest scan. M modified · A added · ? untracked · ! conflict. Refresh to check again.";
  return { files, directories, notice };
}
