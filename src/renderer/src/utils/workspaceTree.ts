import type { WorkspaceEntry } from "@shared/contracts";

export interface WorkspaceTreeRow {
  entry: WorkspaceEntry;
  depth: number;
  parentPath: string;
  expanded: boolean;
}

export type WorkspaceTreeKeyboardAction =
  | { type: "focus"; path: string }
  | { type: "toggle"; path: string }
  | { type: "open"; path: string }
  | { type: "none" };

const workspacePathCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function isSafeWorkspaceEntryPath(path: string): boolean {
  if (
    typeof path !== "string"
    || path.length === 0
    || path.length > 4_096
    || /[\0\r\n]/u.test(path)
    || path.startsWith("/")
  ) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function workspacePathName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function workspaceParentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function compareText(left: string, right: string): number {
  const primary = workspacePathCollator.compare(left, right);
  if (primary !== 0) return primary;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortWorkspaceEntries(
  entries: readonly WorkspaceEntry[],
): WorkspaceEntry[] {
  return entries
    .filter((entry) => isSafeWorkspaceEntryPath(entry.path))
    .slice()
    .sort((left, right) => {
      if (left.kind === "directory" && right.kind !== "directory") return -1;
      if (left.kind !== "directory" && right.kind === "directory") return 1;
      return compareText(workspacePathName(left.path), workspacePathName(right.path))
        || compareText(left.path, right.path);
    });
}

/**
 * Flattens only pages reached through expanded direct-child directories.
 * Invalid, misplaced, or cyclic server entries are ignored defensively.
 */
export function flattenWorkspaceTree(
  pages: ReadonlyMap<string, readonly WorkspaceEntry[]>,
  expandedPaths: ReadonlySet<string>,
): WorkspaceTreeRow[] {
  const rows: WorkspaceTreeRow[] = [];
  const visitedDirectories = new Set<string>();
  const visit = (directory: string, depth: number): void => {
    if (visitedDirectories.has(directory)) return;
    visitedDirectories.add(directory);
    for (const entry of sortWorkspaceEntries(pages.get(directory) ?? [])) {
      if (workspaceParentPath(entry.path) !== directory) continue;
      const expanded = entry.kind === "directory" && expandedPaths.has(entry.path);
      rows.push({ entry, depth, parentPath: directory, expanded });
      if (expanded) visit(entry.path, depth + 1);
    }
  };
  visit("", 1);
  return rows;
}

export function workspaceTreeKeyboardAction(
  key: string,
  currentPath: string,
  rows: readonly WorkspaceTreeRow[],
): WorkspaceTreeKeyboardAction {
  const index = rows.findIndex(({ entry }) => entry.path === currentPath);
  if (index < 0) return { type: "none" };
  const current = rows[index]!;
  if (key === "ArrowDown" && index < rows.length - 1) {
    return { type: "focus", path: rows[index + 1]!.entry.path };
  }
  if (key === "ArrowUp" && index > 0) {
    return { type: "focus", path: rows[index - 1]!.entry.path };
  }
  if (key === "Home" && rows.length > 0) {
    return { type: "focus", path: rows[0]!.entry.path };
  }
  if (key === "End" && rows.length > 0) {
    return { type: "focus", path: rows.at(-1)!.entry.path };
  }
  if (key === "ArrowRight" && current.entry.kind === "directory") {
    if (!current.expanded) return { type: "toggle", path: current.entry.path };
    const child = rows[index + 1];
    if (child?.parentPath === current.entry.path) {
      return { type: "focus", path: child.entry.path };
    }
  }
  if (key === "ArrowLeft") {
    if (current.entry.kind === "directory" && current.expanded) {
      return { type: "toggle", path: current.entry.path };
    }
    if (current.parentPath) return { type: "focus", path: current.parentPath };
  }
  if (key === "Enter" || key === " ") {
    return current.entry.kind === "directory"
      ? { type: "toggle", path: current.entry.path }
      : { type: "open", path: current.entry.path };
  }
  return { type: "none" };
}
