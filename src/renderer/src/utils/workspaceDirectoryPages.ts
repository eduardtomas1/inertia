import type { WorkspaceEntry } from "@shared/contracts";
import { isSafeWorkspaceEntryPath, sortWorkspaceEntries, workspaceParentPath } from "./workspaceTree";

export interface DirectoryPage { entries: WorkspaceEntry[]; truncated: boolean }
export function freshWorkspaceDirectoryPages(entries: WorkspaceEntry[], truncated: boolean): Map<string, DirectoryPage> {
  return new Map([["", { entries: sortWorkspaceEntries(entries), truncated }]]);
}
export function directoryChain(path: string): string[] {
  return path ? path.split("/").map((_, index, segments) => segments.slice(0, index + 1).join("/")) : [];
}
export function visibleDirectoryEntries(pages: ReadonlyMap<string, DirectoryPage>, selectedPath: string | null): Map<string, readonly WorkspaceEntry[]> {
  const entries = new Map<string, readonly WorkspaceEntry[]>([...pages].map(([path, page]) => [path, page.entries]));
  if (!selectedPath || !isSafeWorkspaceEntryPath(selectedPath)) return entries;
  for (const path of directoryChain(selectedPath)) {
    const parent = workspaceParentPath(path);
    const page = pages.get(parent);
    if (page?.truncated && !page.entries.some((entry) => entry.path === path)) {
      entries.set(parent, [...page.entries, { path, kind: path === selectedPath ? "file" : "directory" }]);
    }
  }
  return entries;
}
