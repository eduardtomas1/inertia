import { type Dirent, type Stats } from "node:fs";
import {
  lstat,
  opendir,
  realpath,
} from "node:fs/promises";
import {
  isAbsolute,
  relative,
  sep,
} from "node:path";

export type WorkspaceEntryKind =
  | "file"
  | "directory"
  | "symlink"
  | "other";

export interface WorkspaceEntryIdentity {
  dev: number;
  ino: number;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: WorkspaceEntryKind;
  size: number | null;
  modifiedAt: string | null;
  hidden: boolean;
}

export interface StableWorkspaceEntry {
  kind: WorkspaceEntryKind;
  size: number | null;
  modifiedAt: string | null;
  identity: WorkspaceEntryIdentity;
}

export interface ObservedWorkspaceEntry {
  absolute: string;
  kind: WorkspaceEntryKind;
}

function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === ""
    || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function sameIdentity(
  left: WorkspaceEntryIdentity,
  right: WorkspaceEntryIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function entryKind(info: Stats): WorkspaceEntryKind {
  if (info.isSymbolicLink()) return "symlink";
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return "other";
}

async function stableContainedDirectory(
  root: string,
  absolute: string,
  identity: WorkspaceEntryIdentity,
): Promise<boolean> {
  const info = await lstat(absolute);
  return !info.isSymbolicLink()
    && info.isDirectory()
    && sameIdentity(info, identity)
    && isContained(root, await realpath(absolute));
}

async function stableDirectoryIdentity(
  absolute: string,
  identity: WorkspaceEntryIdentity,
): Promise<boolean> {
  const info = await lstat(absolute);
  return !info.isSymbolicLink()
    && info.isDirectory()
    && sameIdentity(info, identity);
}

export async function openStableWorkspaceDirectory(
  root: string,
  absolute: string,
  identity: WorkspaceEntryIdentity,
) {
  if (!(await stableContainedDirectory(root, absolute, identity))) return null;
  const handle = await opendir(absolute);
  try {
    if (await stableContainedDirectory(root, absolute, identity)) return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();
  return null;
}

export function workspaceDirentKind(child: Dirent): WorkspaceEntryKind {
  if (child.isSymbolicLink()) return "symlink";
  if (child.isDirectory()) return "directory";
  if (child.isFile()) return "file";
  return "other";
}

export function compareWorkspaceEntries(
  left: WorkspaceEntry,
  right: WorkspaceEntry,
): number {
  if (left.kind === "directory" && right.kind !== "directory") return -1;
  if (left.kind !== "directory" && right.kind === "directory") return 1;
  return left.name.localeCompare(
    right.name,
    undefined,
    { numeric: true, sensitivity: "base" },
  ) || left.path.localeCompare(
    right.path,
    undefined,
    { numeric: true, sensitivity: "variant" },
  );
}

export async function describeStableWorkspaceEntry(
  root: string,
  parentAbsolute: string,
  parentIdentity: WorkspaceEntryIdentity,
  absolute: string,
  observedKind: WorkspaceEntryKind,
): Promise<StableWorkspaceEntry | null> {
  return (await describeStableWorkspaceEntries(
    root,
    parentAbsolute,
    parentIdentity,
    [{ absolute, kind: observedKind }],
  ))[0] ?? null;
}

/**
 * Describes one bounded directory page under a shared parent-stability check.
 * The parent is verified before and after the complete metadata batch, so a
 * replacement invalidates every result rather than exposing a mixed page.
 */
export async function describeStableWorkspaceEntries(
  root: string,
  parentAbsolute: string,
  parentIdentity: WorkspaceEntryIdentity,
  observed: readonly ObservedWorkspaceEntry[],
): Promise<Array<StableWorkspaceEntry | null>> {
  if (!(await stableContainedDirectory(root, parentAbsolute, parentIdentity))) {
    return observed.map(() => null);
  }
  const described = await Promise.all(observed.map(async ({ absolute, kind: observedKind }) => {
    if (!(await stableDirectoryIdentity(parentAbsolute, parentIdentity))) {
      return null;
    }
    const info = await lstat(absolute);
    const kind = entryKind(info);
    if (
      (observedKind !== "other" && kind !== observedKind)
      || !(await stableDirectoryIdentity(parentAbsolute, parentIdentity))
    ) return null;
    return {
      kind,
      size: kind === "file" ? info.size : null,
      modifiedAt: Number.isFinite(info.mtimeMs) ? info.mtime.toISOString() : null,
      identity: { dev: info.dev, ino: info.ino },
    } satisfies StableWorkspaceEntry;
  }));
  if (!(await stableContainedDirectory(root, parentAbsolute, parentIdentity))) {
    return observed.map(() => null);
  }
  return described;
}
