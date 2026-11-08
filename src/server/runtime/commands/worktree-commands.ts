import type WebSocket from "ws";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { ServerEvent } from "../../../shared/contracts";
import {
  MAX_LISTED_WORKTREES,
  type WorktreeActionOutcome,
  type WorktreeEntry,
  type WorktreeList,
} from "../../../shared/worktrees";
import type { RuntimeStore } from "../../database";
import { inspectOwnedWorktreeCleanupState } from "../../git";
import { repositoryRoot } from "../../git/paths";
import { isGitProcessTreeTerminationFailure } from "../../git/types";
import {
  deleteMergedBranch,
  inspectWorktreeChanges,
  listGitWorktrees,
  removeMissingWorktreeEntry,
  removeRegisteredWorktree,
  type GitWorktreeChanges,
  type GitWorktreeRecord,
} from "../../git/worktree-inventory";
import type { ProjectWorktreeRecord } from "../../persistence/conversation-worktree-repository";
import type { ProviderTerminalResumeRegistry } from "../../provider/terminal-resume";
import { RuntimeRequestError } from "../../runtime-errors";
import type { WorkspaceRunController } from "../workspace-run-controller";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

export interface WorktreeCommandDependencies {
  store: RuntimeStore;
  workspaceRuns: Pick<WorkspaceRunController<WebSocket>, "trackSourceControl">;
  providerTerminalResumes: Pick<ProviderTerminalResumeRegistry, "isActive">;
  dataDirectory: string;
  broadcastSnapshot(): void;
  send(socket: WebSocket, event: ServerEvent): void;
  /** Runs `git worktree remove`; replaceable to reproduce partial removals. */
  removeRegisteredWorktree?: typeof removeRegisteredWorktree;
}

type CreatedOwnership = Extract<
  NonNullable<ProjectWorktreeRecord["ownership"]>,
  { creationState: "created" }
>;

interface WorktreeContext {
  projectId: string;
  root: string;
  managedRoot: string;
  records: ProjectWorktreeRecord[];
  checkouts: Array<{ conversationId: string; canonicalPath: string }>;
  canonical(path: string): Promise<string>;
}

interface DescribedWorktree {
  entry: WorktreeEntry;
  record: ProjectWorktreeRecord | null;
  canonicalPath: string;
}

/** Whole-list budget for status checks; later entries report an unknown state. */
const LIST_STATUS_BUDGET_MS = 30_000;
const LIST_STATUS_CONCURRENCY = 4;
const NOT_REPOSITORY = "This project is not a Git repository, so it has no worktrees.";

function pathsEqual(left: string, right: string): boolean {
  return relative(left, right) === "";
}

function strictlyInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && !isAbsolute(child) && child !== ".."
    && !child.startsWith("../") && !child.startsWith("..\\");
}

function insideOrEqual(root: string, path: string): boolean {
  return pathsEqual(root, path) || strictlyInside(root, path);
}

function shortTitle(title: string): string {
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

function generatedBranchName(conversationId: string): string {
  return `inertia/${conversationId.slice(0, 8)}`;
}

/** Canonical path, resolved through the parent folder when the entry is gone. */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    try {
      return join(await realpath(dirname(path)), basename(path));
    } catch {
      return resolve(path);
    }
  }
}

async function pathExists(path: string): Promise<boolean | null> {
  return await lstat(path).then(() => true, (error: unknown) =>
    error && typeof error === "object" && "code" in error
      && (error.code === "ENOENT" || error.code === "ENOTDIR")
      ? false
      : null);
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

const UNKNOWN_CHANGES: GitWorktreeChanges = {
  dirty: null, changeCount: null, truncated: false, ignored: null,
};

function displayPath(
  context: WorktreeContext,
  path: string,
): Pick<WorktreeEntry, "path" | "location"> {
  if (insideOrEqual(context.root, path)) {
    return { path: relative(context.root, path) || ".", location: "repository" };
  }
  if (strictlyInside(context.managedRoot, path)) {
    return { path, location: "inertia" };
  }
  // Never reveal where a foreign checkout lives; its folder name is enough.
  return { path: `…/${basename(path) || "worktree"}`, location: "external" };
}

function changeRefusal(changes: GitWorktreeChanges): string | null {
  if (changes.dirty === null) {
    return "Inertia could not confirm this worktree is clean, so it was kept.";
  }
  if (changes.dirty) {
    const count = changes.changeCount ?? 0;
    const files = `${count}${changes.truncated ? "+" : ""} uncommitted ${count === 1 ? "change" : "changes"}`;
    return `This worktree has ${files}. Commit, stash or discard them first.`;
  }
  if (changes.ignored !== false) {
    return "This worktree has ignored files (such as build output or .env) that removal would delete. Remove them first, or remove the worktree with Git.";
  }
  if (changes.hiddenEdits === true) {
    return "This worktree has files marked assume-unchanged or skip-worktree, so Git cannot show their edits and removal would delete them. Clear those marks with git update-index first, or remove the worktree with Git.";
  }
  if (changes.hiddenEdits !== false) {
    return "Inertia could not confirm this worktree has no hidden edits, so it was kept.";
  }
  return null;
}

export function createWorktreeCommandHandler(
  dependencies: WorktreeCommandDependencies,
): RuntimeCommandHandler {
  const { store } = dependencies;
  const removeWorktree = dependencies.removeRegisteredWorktree ?? removeRegisteredWorktree;

  const loadContext = async (projectId: string): Promise<WorktreeContext> => {
    const project = store.project(projectId);
    if (project.workspaceKind === "scratch" || !project.repositoryRoot) {
      throw new RuntimeRequestError(NOT_REPOSITORY);
    }
    let root: string;
    try {
      root = await canonicalPath(await repositoryRoot(store.projectPath(projectId)));
    } catch {
      throw new RuntimeRequestError(NOT_REPOSITORY);
    }
    const cache = new Map<string, Promise<string>>();
    const canonical = (path: string): Promise<string> => {
      const key = resolve(path);
      let value = cache.get(key);
      if (!value) {
        value = canonicalPath(key);
        cache.set(key, value);
      }
      return value;
    };
    const checkouts = await Promise.all(
      store.conversationWorktrees.checkoutPaths().map(async (checkout) => ({
        conversationId: checkout.conversationId,
        canonicalPath: await canonical(checkout.worktreePath),
      })),
    );
    return {
      projectId,
      root,
      managedRoot: await canonicalPath(join(dependencies.dataDirectory, "worktrees")),
      records: store.conversationWorktrees.projectWorktreeRecords(projectId),
      checkouts,
      canonical,
    };
  };

  const chatIsBusy = (
    record: ProjectWorktreeRecord,
    reservationHeld: boolean,
  ): boolean => {
    const conversation = store.conversation(record.conversationId);
    return conversation.status === "running"
      || conversation.status === "needs-input"
      || store.providerRunOwnership.forConversation(record.conversationId).length > 0
      || dependencies.providerTerminalResumes.isActive(record.conversationId)
      // While this command holds the checkout reservation, its own activity
      // row and reservation are the only work allowed at the worktree.
      || (!reservationHeld
        && store.hasActiveWorkspaceRunForConversation(record.conversationId));
  };

  const describe = async (
    context: WorktreeContext,
    worktree: GitWorktreeRecord,
    reservationHeld = false,
    statusDeadlineAt?: number,
  ): Promise<DescribedWorktree> => {
    const path = await context.canonical(worktree.path);
    let record: ProjectWorktreeRecord | null = null;
    for (const candidate of context.records) {
      if (
        candidate.ownership?.ownsWorktree
        && pathsEqual(await context.canonical(candidate.ownership.path), path)
      ) {
        record = candidate;
        break;
      }
    }
    const sharedChatCount = context.checkouts.filter((checkout) =>
      checkout.conversationId !== record?.conversationId
      && pathsEqual(checkout.canonicalPath, path)).length;
    const changes: GitWorktreeChanges = worktree.prunable || worktree.bare
      ? UNKNOWN_CHANGES
      // Only a worktree Inertia could remove needs the full index listing.
      : await inspectWorktreeChanges(
          path,
          statusDeadlineAt,
          !worktree.isMain && Boolean(record?.ownership?.ownsWorktree),
        ).catch(() => UNKNOWN_CHANGES);
    const ownership = record?.ownership ?? null;
    const reason = await (async (): Promise<string | null> => {
      if (worktree.isMain) return "This is the project's main checkout, which is never removed here.";
      if (!record || !ownership?.ownsWorktree) {
        return "Inertia did not create this worktree. Remove it with Git if you no longer need it.";
      }
      if (ownership.creationState !== "created") {
        return "Worktree creation was interrupted. Remove the worktree and its branch manually with Git, then delete the chat.";
      }
      if (record.duo) return "This worktree belongs to a Duo comparison. Delete its chat to clean it up.";
      if (!strictlyInside(context.managedRoot, path)) {
        return "This worktree is outside Inertia's worktree folder, so it was kept.";
      }
      if (chatIsBusy(record, reservationHeld)) {
        return `Stop the chat “${shortTitle(record.title)}” before removing its worktree.`;
      }
      if (sharedChatCount > 0) return "Another chat also uses this worktree, so it was kept.";
      if (
        record.worktreePath === null
        || !pathsEqual(await context.canonical(record.worktreePath), path)
      ) {
        return "This worktree no longer matches its chat's ownership receipt, so it was kept.";
      }
      if (worktree.locked) return "Git has locked this worktree. Unlock it with Git first.";
      if (worktree.prunable) return "The worktree folder is missing. Use Prune to clear the stale entry.";
      if (worktree.branch !== ownership.branch) {
        return `This worktree is no longer on ${ownership.branch}, the branch Inertia created, so it was kept.`;
      }
      return changeRefusal(changes);
    })();
    return {
      record,
      canonicalPath: path,
      entry: {
        ...displayPath(context, path),
        branch: worktree.branch,
        head: worktree.head,
        isMain: worktree.isMain,
        owned: Boolean(ownership?.ownsWorktree),
        conversationId: record?.conversationId ?? null,
        title: record ? record.title.slice(0, 1_000) : null,
        chatStatus: record ? store.conversation(record.conversationId).status : null,
        sharedChatCount,
        dirty: changes.dirty,
        changeCount: changes.changeCount,
        changeCountTruncated: changes.truncated,
        ignoredFiles: changes.ignored,
        locked: worktree.locked,
        prunable: worktree.prunable,
        removal: reason === null ? { allowed: true } : { allowed: false, reason },
      },
    };
  };

  const list = async (projectId: string): Promise<WorktreeList> => {
    const context = await loadContext(projectId);
    const inventory = await listGitWorktrees(context.root, MAX_LISTED_WORKTREES);
    const deadlineAt = Date.now() + LIST_STATUS_BUDGET_MS;
    const worktrees: WorktreeEntry[] = Array.from({ length: inventory.worktrees.length });
    let next = 0;
    await Promise.all(Array.from({ length: LIST_STATUS_CONCURRENCY }, async () => {
      while (next < inventory.worktrees.length) {
        const index = next;
        next += 1;
        worktrees[index] = (await describe(context, inventory.worktrees[index]!, false, deadlineAt)).entry;
      }
    }));
    return { projectId, worktrees, truncated: inventory.truncated };
  };

  /** Resolves the request to one removable, receipt-verified worktree or refuses. */
  const removable = async (
    projectId: string,
    requestedPath: string,
    reservationHeld: boolean,
  ): Promise<{
    context: WorktreeContext;
    worktree: GitWorktreeRecord;
    described: DescribedWorktree;
    ownership: CreatedOwnership;
    sourceBranch: string | null;
  }> => {
    if (!isAbsolute(requestedPath)) {
      throw new RuntimeRequestError("Only worktrees inside Inertia's worktree folder can be removed.");
    }
    const context = await loadContext(projectId);
    const target = await context.canonical(requestedPath);
    if (!strictlyInside(context.managedRoot, target)) {
      throw new RuntimeRequestError("Only worktrees inside Inertia's worktree folder can be removed.");
    }
    // Look past the display bound: a removable worktree must never be hidden by it.
    const inventory = await listGitWorktrees(context.root, Number.MAX_SAFE_INTEGER);
    let worktree: GitWorktreeRecord | null = null;
    for (const candidate of inventory.worktrees) {
      if (pathsEqual(await context.canonical(candidate.path), target)) {
        worktree = candidate;
        break;
      }
    }
    if (!worktree) {
      throw new RuntimeRequestError("Git does not list this worktree for the project's repository.");
    }
    const described = await describe(context, worktree, reservationHeld);
    if (!described.entry.removal.allowed) {
      throw new RuntimeRequestError(described.entry.removal.reason);
    }
    const ownership = described.record?.ownership;
    if (!ownership?.ownsWorktree || ownership.creationState !== "created") {
      throw new RuntimeRequestError("Inertia did not create this worktree, so it was kept.");
    }
    const inspection = await inspectOwnedWorktreeCleanupState(
      context.root,
      ownership.path,
      ownership.branch,
      ownership.branchHead,
      ownership.worktreeId,
      ownership.repositoryIdentity,
      ownership.ownershipToken,
      ownership.filesystemReceipt,
    );
    if (
      inspection.state !== "registered"
      || !pathsEqual(await context.canonical(inspection.identity.path), target)
      || inspection.identity.branch !== ownership.branch
    ) {
      throw new RuntimeRequestError(
        "The worktree was replaced or changed ownership since Inertia created it, so it was kept.",
      );
    }
    const main = inventory.worktrees.find(({ isMain }) => isMain);
    return {
      context,
      worktree,
      described,
      ownership,
      sourceBranch: main?.branch ?? null,
    };
  };

  const inspectCleanup = async (
    root: string,
    ownership: CreatedOwnership,
  ) => await inspectOwnedWorktreeCleanupState(
    root,
    ownership.path,
    ownership.branch,
    ownership.branchHead,
    ownership.worktreeId,
    ownership.repositoryIdentity,
    ownership.ownershipToken,
    ownership.filesystemReceipt,
  );

  /** Whether Git still lists a worktree at the path; null when Git could not tell. */
  const stillListed = async (
    context: WorktreeContext,
    target: string,
  ): Promise<boolean | null> => {
    try {
      const inventory = await listGitWorktrees(context.root, Number.MAX_SAFE_INTEGER);
      for (const candidate of inventory.worktrees) {
        if (pathsEqual(await canonicalPath(candidate.path), target)) return true;
      }
      return false;
    } catch {
      return null;
    }
  };

  /**
   * Describes a failed `git worktree remove` truthfully. Git deletes the
   * folder before its administrative entry and continues after a failed
   * deletion, so a failure can leave a partly deleted folder that Git no
   * longer knows about. Nothing here claims the files were kept unless the
   * folder still checks clean.
   */
  const intactAfterRefusal = async (target: string): Promise<boolean> => {
    if (await pathExists(join(target, ".git")) !== true) return false;
    const changes = await inspectWorktreeChanges(target).catch(() => UNKNOWN_CHANGES);
    return changes.dirty === false
      && changes.ignored === false
      && changes.hiddenEdits === false;
  };

  const branchCleanup = async (
    checked: Awaited<ReturnType<typeof removable>>,
    conversationId: string,
  ): Promise<{ branchDeleted: boolean; branchNote: string }> => {
    const branch = checked.ownership.branch;
    const generated = branch === generatedBranchName(conversationId);
    const branchDeleted = generated && checked.sourceBranch !== null
      ? await deleteMergedBranch(checked.context.root, branch, checked.sourceBranch)
        .catch(() => false)
      : false;
    const branchNote = branchDeleted
      ? ` Deleted branch ${branch}, which was merged into ${checked.sourceBranch}.`
      : generated
        ? ` Kept branch ${branch} because it is not fully merged${checked.sourceBranch ? ` into ${checked.sourceBranch}` : ""}.`
        : ` Kept branch ${branch}.`;
    return { branchDeleted, branchNote };
  };

  /**
   * Clears stale administrative entries one by one, and only for worktrees
   * inside Inertia's worktree folder. `git worktree prune` would also drop
   * the entry, index and HEAD of any other worktree whose folder is merely
   * unreachable, such as one on a disconnected drive.
   */
  const prune = async (projectId: string): Promise<WorktreeActionOutcome> => {
    const context = await loadContext(projectId);
    const inventory = await listGitWorktrees(context.root, Number.MAX_SAFE_INTEGER);
    let cleared = 0;
    let keptForChats = 0;
    let keptOutside = 0;
    for (const worktree of inventory.worktrees) {
      if (worktree.isMain || !worktree.prunable || worktree.locked) continue;
      const path = await context.canonical(worktree.path);
      if (!strictlyInside(context.managedRoot, path)) {
        keptOutside += 1;
        continue;
      }
      let record: ProjectWorktreeRecord | null = null;
      for (const candidate of context.records) {
        if (
          candidate.ownership?.ownsWorktree
          && pathsEqual(await context.canonical(candidate.ownership.path), path)
        ) {
          record = candidate;
          break;
        }
      }
      const ownership = record?.ownership;
      if (!record || !ownership) {
        if (await removeMissingWorktreeEntry(context.root, worktree.path)) cleared += 1;
        continue;
      }
      if (ownership.creationState !== "created" || record.duo) {
        keptForChats += 1;
        continue;
      }
      const before = await inspectCleanup(context.root, ownership).catch(() => null);
      if (
        before?.state !== "registered"
        || !pathsEqual(await context.canonical(before.identity.path), path)
      ) {
        keptForChats += 1;
        continue;
      }
      if (!await removeMissingWorktreeEntry(context.root, worktree.path)) continue;
      cleared += 1;
      // Like a removal, a cleared entry releases the chat's receipt so a
      // later chat deletion does not look for the worktree again.
      const after = await inspectCleanup(context.root, ownership).catch(() => null);
      if (after?.state === "absent") {
        store.conversationWorktrees.releaseRemovedWorktree(
          record.conversationId,
          ownership.ownershipToken,
        );
      }
    }
    const notes = [
      cleared === 0
        ? "No stale worktree entries were found in Inertia's worktree folder."
        : `Cleared ${cleared} stale worktree ${plural(cleared, "entry", "entries")} from Inertia's worktree folder.`,
    ];
    if (keptForChats > 0) {
      notes.push(`Kept ${keptForChats} stale ${plural(keptForChats, "entry", "entries")} that ${plural(keptForChats, "belongs", "belong")} to a chat Inertia could not safely clear.`);
    }
    if (keptOutside > 0) {
      notes.push(`Kept ${keptOutside} stale ${plural(keptOutside, "entry", "entries")} outside Inertia's worktree folder, whose ${plural(keptOutside, "folder", "folders")} may be on a disconnected drive. Prune with Git only if ${plural(keptOutside, "it is", "they are")} gone for good.`);
    }
    notes.push("No files were changed.");
    return { action: "prune", branchDeleted: false, message: notes.join(" ") };
  };

  return defineRuntimeCommandHandler([
    "worktree.list",
    "worktree.remove",
    "worktree.prune",
  ], async (socket, command) => {
    switch (command.type) {
      case "worktree.list": {
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "worktree.list", list: await list(command.payload.projectId) },
        });
        return "handled";
      }
      case "worktree.remove": {
        const { projectId, path } = command.payload;
        const first = await removable(projectId, path, false);
        const conversationId = first.described.record!.conversationId;
        const outcome = await dependencies.workspaceRuns.trackSourceControl(
          "Remove worktree",
          projectId,
          conversationId,
          first.described.canonicalPath,
          command.requestId,
          async () => {
            // Re-check everything under the exclusive checkout reservation.
            const checked = await removable(projectId, path, true);
            if (
              checked.described.record?.conversationId !== conversationId
              || checked.ownership.ownershipToken !== first.ownership.ownershipToken
            ) {
              throw new RuntimeRequestError(
                "The worktree changed ownership while Inertia checked it, so it was kept.",
              );
            }
            const target = checked.described.canonicalPath;
            const shown = checked.described.entry.path;
            // Narrow the window for writers outside Inertia: repeat the change
            // and ignored-file check immediately before Git deletes the folder.
            const refusal = changeRefusal(
              await inspectWorktreeChanges(target).catch(() => UNKNOWN_CHANGES),
            );
            if (refusal) throw new RuntimeRequestError(refusal);
            let removalFailed = false;
            try {
              await removeWorktree(checked.context.root, checked.worktree.path);
            } catch (error) {
              if (isGitProcessTreeTerminationFailure(error)) throw error;
              removalFailed = true;
            }
            const after = await inspectCleanup(checked.context.root, checked.ownership)
              .catch(() => null);
            const listed = await stillListed(checked.context, target);
            const unregistered = after?.state === "absent" && listed === false;
            if (!removalFailed && !unregistered) {
              throw new RuntimeRequestError(
                "Git still lists the worktree after removal. Inertia kept its ownership receipt.",
              );
            }
            if (removalFailed && !unregistered) {
              if (listed === false) {
                throw new RuntimeRequestError(
                  `Git unregistered the worktree but could not delete all of its files. Delete what is left in ${shown} by hand. Inertia could not verify the chat's ownership receipt, so it kept it.`,
                );
              }
              if (await intactAfterRefusal(target)) {
                throw new RuntimeRequestError("Git refused to remove the worktree. Its files were kept.");
              }
              throw new RuntimeRequestError(
                `Git did not finish removing the worktree, and some of its files may already be deleted. It is still registered at ${shown}; check that folder before retrying.`,
              );
            }
            store.conversationWorktrees.releaseRemovedWorktree(
              conversationId,
              checked.ownership.ownershipToken,
            );
            const { branchDeleted, branchNote } = await branchCleanup(checked, conversationId);
            const leftover = removalFailed ? await pathExists(target) : false;
            if (leftover !== false) {
              return {
                action: "remove" as const,
                branchDeleted,
                partial: true as const,
                message: `Git unregistered the worktree but could not delete all of its files, usually because a program still has one open. What is left is in ${shown}; close that program and delete the folder by hand.${branchNote}`,
              };
            }
            return {
              action: "remove" as const,
              branchDeleted,
              message: `Removed the worktree ${shown}.${branchNote}`,
            };
          },
          { serializationRoot: first.context.root, exclusiveCheckout: true },
        );
        dependencies.broadcastSnapshot();
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "worktree.action", outcome },
        });
        return "handled";
      }
      case "worktree.prune": {
        const { projectId } = command.payload;
        const context = await loadContext(projectId);
        // Serialized with every other Git mutation of this repository and
        // recorded as workspace activity; the reservation covers Inertia's
        // worktree folder, the only place entries are cleared.
        const outcome = await dependencies.workspaceRuns.trackSourceControl(
          "Prune worktrees",
          projectId,
          undefined,
          context.managedRoot,
          command.requestId,
          async () => await prune(projectId),
          { serializationRoot: context.root },
        );
        dependencies.broadcastSnapshot();
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "worktree.action", outcome },
        });
        return "handled";
      }
      default:
        return "not-handled";
    }
  });
}
