import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import { GitError } from "../git";
import {
  repositoryMetadataMarkerIdentity,
  repositoryRoot,
} from "../git/paths";
import type { WorkspaceRunController } from "./workspace-run-controller";

export interface PinnedWorktreeSourceIdentity {
  canonicalWorkspace: string;
  workspaceDevice: string;
  workspaceInode: string;
  workspaceBirthtimeNs: string;
  root: string;
  rootDevice: string;
  rootInode: string;
  rootBirthtimeNs: string;
  metadataMarkerIdentity: string;
}

function metadataMarkerIdentitiesEqual(left: string, right: string): boolean {
  if (left === right) return true;
  const leftParts = left.split("\0");
  const rightParts = right.split("\0");
  if (
    leftParts.length !== 10
    || rightParts.length !== 10
    || leftParts[0] !== "git-dir"
    || rightParts[0] !== "git-dir"
    || leftParts[5] !== "git-common-dir"
    || rightParts[5] !== "git-common-dir"
  ) return false;
  return [2, 3, 4, 7, 8, 9].every(
    (index) => leftParts[index] === rightParts[index],
  );
}

function pathIsContained(root: string, candidate: string): boolean {
  const nested = relative(root, candidate);
  return nested === "" || (
    nested !== ".."
    && !nested.startsWith(`..${sep}`)
    && !isAbsolute(nested)
  );
}

export function worktreeSourceIdentitiesEqual(
  left: PinnedWorktreeSourceIdentity,
  right: PinnedWorktreeSourceIdentity,
): boolean {
  return left.workspaceDevice === right.workspaceDevice
    && left.workspaceInode === right.workspaceInode
    && left.workspaceBirthtimeNs === right.workspaceBirthtimeNs
    && left.rootDevice === right.rootDevice
    && left.rootInode === right.rootInode
    && left.rootBirthtimeNs === right.rootBirthtimeNs
    && metadataMarkerIdentitiesEqual(
      left.metadataMarkerIdentity,
      right.metadataMarkerIdentity,
    );
}

export function worktreeSourceIdentityKey(
  identity: PinnedWorktreeSourceIdentity,
): string {
  return [
    identity.rootDevice,
    identity.rootInode,
    identity.rootBirthtimeNs,
  ].join("\0");
}

export interface WorktreeSourceReservation {
  identity: PinnedWorktreeSourceIdentity;
  ordinal: number;
  projectId: string;
  workspacePath: string;
}

export async function withWorktreeSourceReservations<Result>(
  workspaceRuns: Pick<WorkspaceRunController<unknown>, "trackSourceControl">
    | null
    | undefined,
  launchId: string,
  reservations: readonly WorktreeSourceReservation[],
  operation: () => Promise<Result>,
): Promise<Result> {
  const sources = [...new Map(reservations.map((reservation) => [
    worktreeSourceIdentityKey(reservation.identity),
    reservation,
  ] as const)).values()].sort((left, right) =>
    worktreeSourceIdentityKey(left.identity).localeCompare(
      worktreeSourceIdentityKey(right.identity),
    ));
  const runReserved = async (index: number): Promise<Result> => {
    const source = sources[index];
    if (!source) {
      await Promise.all(sources.map(async (candidate) => {
        await verifyWorktreeSourceIdentity(
          candidate.workspacePath,
          candidate.identity,
        );
      }));
      return await operation();
    }
    if (!workspaceRuns) return await runReserved(index + 1);
    return await workspaceRuns.trackSourceControl(
      "Create Duo worktree",
      source.projectId,
      undefined,
      source.identity.root,
      `duo-worktree:${launchId}:${source.ordinal}`,
      async () => await runReserved(index + 1),
    );
  };
  return await runReserved(0);
}

function changedSourceError(): GitError {
  return new GitError(
    "conflict",
    "The project repository changed while its isolated worktree was being prepared. Refresh and try again.",
  );
}

async function inspectWorktreeSource(
  workspacePath: string,
): Promise<PinnedWorktreeSourceIdentity> {
  try {
    const canonicalWorkspace = await realpath(workspacePath);
    const root = await repositoryRoot(canonicalWorkspace);
    if (!pathIsContained(root, canonicalWorkspace)) {
      throw changedSourceError();
    }
    const [workspaceInfo, rootInfo, metadataMarkerIdentity] = await Promise.all([
      lstat(canonicalWorkspace, { bigint: true }),
      lstat(root, { bigint: true }),
      repositoryMetadataMarkerIdentity(root),
    ]);
    if (
      !workspaceInfo.isDirectory()
      || workspaceInfo.isSymbolicLink()
      || workspaceInfo.ino <= 0n
      || workspaceInfo.birthtimeNs <= 0n
      || !rootInfo.isDirectory()
      || rootInfo.isSymbolicLink()
      || rootInfo.ino <= 0n
      || rootInfo.birthtimeNs <= 0n
    ) {
      throw changedSourceError();
    }
    return {
      canonicalWorkspace,
      workspaceDevice: workspaceInfo.dev.toString(10),
      workspaceInode: workspaceInfo.ino.toString(10),
      workspaceBirthtimeNs: workspaceInfo.birthtimeNs.toString(10),
      root,
      rootDevice: rootInfo.dev.toString(10),
      rootInode: rootInfo.ino.toString(10),
      rootBirthtimeNs: rootInfo.birthtimeNs.toString(10),
      metadataMarkerIdentity,
    };
  } catch (error) {
    if (error instanceof GitError) throw error;
    throw changedSourceError();
  }
}

export async function pinWorktreeSourceIdentity(
  workspacePath: string,
): Promise<PinnedWorktreeSourceIdentity> {
  const before = await inspectWorktreeSource(workspacePath);
  const after = await inspectWorktreeSource(workspacePath);
  if (!worktreeSourceIdentitiesEqual(before, after)) {
    throw changedSourceError();
  }
  return after;
}

export async function verifyWorktreeSourceIdentity(
  workspacePath: string,
  pinned: PinnedWorktreeSourceIdentity,
): Promise<string> {
  const current = await inspectWorktreeSource(workspacePath);
  if (!worktreeSourceIdentitiesEqual(current, pinned)) {
    throw changedSourceError();
  }
  return current.root;
}
