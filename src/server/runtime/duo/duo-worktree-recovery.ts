import { resolve } from "node:path";

import type { RuntimeStore } from "../../database";
import {
  createWorktreeWithOwnershipReceipt,
  inspectBranchCleanupOutcome,
  inspectOwnedWorktreeCleanupState,
  inspectUnacknowledgedWorktreeCreation,
  preflightWorktreeFilesystemIdentity,
  type OwnedWorktreeCreationHooks,
} from "../../git";
import type { WorktreeFilesystemReceipt } from "../../worktree-filesystem-identity";

export interface DuoWorktreeOperations {
  preflightFilesystem(repositoryPath: string): Promise<void>;
  create(
    repositoryPath: string,
    worktreePath: string,
    options: { branch: string; createBranch: true; startPoint: string },
    hooks: OwnedWorktreeCreationHooks,
  ): ReturnType<typeof createWorktreeWithOwnershipReceipt>;
  inspectWorktree(
    repositoryPath: string,
    worktreePath: string,
    expectedBranch: string,
    expectedHead: string,
    expectedWorktreeId: string,
    expectedRepositoryIdentity: string,
    expectedOwnershipToken: string,
    expectedFilesystemReceipt: WorktreeFilesystemReceipt,
  ): ReturnType<typeof inspectOwnedWorktreeCleanupState>;
  inspectCreatingWorktree(
    repositoryPath: string,
    worktreePath: string,
    expectedBranch: string,
  ): ReturnType<typeof inspectUnacknowledgedWorktreeCreation>;
  inspectBranch(
    repositoryPath: string,
    branch: string,
    expectedHead: string,
  ): ReturnType<typeof inspectBranchCleanupOutcome>;
}

export function defaultDuoWorktreeOperations(): DuoWorktreeOperations {
  return {
    preflightFilesystem: preflightWorktreeFilesystemIdentity,
    create: createWorktreeWithOwnershipReceipt,
    inspectCreatingWorktree: inspectUnacknowledgedWorktreeCreation,
    inspectWorktree: inspectOwnedWorktreeCleanupState,
    inspectBranch: inspectBranchCleanupOutcome,
  };
}

export function duoLaunchErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The Duo launch could not be prepared.";
}

class RetainedWorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetainedWorktreeError";
  }
}

function expectedLaunchOwnedBranch(
  plan: ReturnType<RuntimeStore["pairedLaunch"]>["plans"][number],
): string {
  const expected = `inertia/${plan.plannedConversationId.slice(0, 8)}`;
  if (plan.plannedBranch !== expected) {
    throw new Error(
      "The Duo cleanup branch does not match its generated launch identity.",
    );
  }
  return expected;
}

export async function cleanupUnadoptedOwnedWorktree(
  store: RuntimeStore,
  launchId: string,
  ordinal: 0 | 1,
  worktrees: DuoWorktreeOperations,
): Promise<void> {
  const launch = store.pairedLaunch(launchId);
  const plan = launch.plans[ordinal];
  const side = launch.sides[ordinal];
  if (
    !plan.ownsWorktree
    || !plan.plannedWorktreePath
    || side.conversationId
  ) return;
  const worktreePath = plan.plannedWorktreePath;
  const branch = expectedLaunchOwnedBranch(plan);
  const repositoryPath = store.projectPath(plan.projectId);
  if (
    plan.worktreeCreationState === "pending"
    || plan.worktreeCreationState === "not-created"
  ) return;
  if (plan.worktreeCreationState === "creating") {
    const inspection = await worktrees.inspectCreatingWorktree(
      repositoryPath,
      worktreePath,
      branch,
    );
    if (inspection === "retained") {
      throw new RetainedWorktreeError(
        "Worktree creation was interrupted before durable ownership acknowledgement and planned artifacts may remain. Automatic cleanup was withheld.",
      );
    }
    store.rejectPairedLaunchWorktreeCreation(launchId, ordinal);
    return;
  }
  const branchHead = plan.cleanupBranchHead;
  const worktreeId = plan.cleanupWorktreeId;
  const repositoryIdentity = plan.cleanupRepositoryIdentity;
  const ownershipToken = plan.cleanupWorktreeToken;
  const filesystemReceipt = plan.cleanupFilesystemReceipt;
  if (
    !branchHead
    || !worktreeId
    || !repositoryIdentity
    || !ownershipToken
    || !filesystemReceipt
  ) {
    throw new Error(
      "The durable linked-worktree identity is incomplete. Automatic cleanup was withheld and absence cannot be inferred.",
    );
  }
  const inspection = await worktrees.inspectWorktree(
    repositoryPath,
    worktreePath,
    branch,
    branchHead,
    worktreeId,
    repositoryIdentity,
    ownershipToken,
    filesystemReceipt,
  );
  if (inspection.state !== "absent") {
    const registered = inspection.state === "registered"
      ? inspection.identity
      : null;
    const exact = registered !== null
      && resolve(registered.path) === resolve(worktreePath)
      && registered.branch === branch
      && registered.head === branchHead;
    store.recordPairedLaunchWorktreeCleanupObservation(
      launchId,
      ordinal,
      "retained",
      {
        topology: exact ? "owned" : "conflict",
        path: registered?.path ?? null,
        branch: registered?.branch ?? null,
        head: registered?.head ?? null,
      },
    );
    if (!exact) {
      throw new RetainedWorktreeError(
        "A launch-owned linked-worktree identity remains or conflicts with the expected topology. Automatic cleanup was withheld. Review the structured recovery details before making a manual change.",
      );
    }
    throw new RetainedWorktreeError(
      "A launch-owned linked worktree remains registered. Automatic cleanup was withheld because Git cannot atomically guard its identity during removal. Review the structured recovery details and remove it manually with a platform-appropriate Git client.",
    );
  }
  store.recordPairedLaunchWorktreeCleanupObservation(
    launchId,
    ordinal,
    "absent",
    { topology: null, path: null, branch: null, head: null },
  );
  const branchOutcome = await worktrees.inspectBranch(
    repositoryPath,
    branch,
    branchHead,
  );
  store.recordPairedLaunchBranchCleanupOutcome(
    launchId,
    ordinal,
    branchOutcome,
  );
  if (branchOutcome === "retained") {
    throw new RetainedWorktreeError(
      "The launch-owned linked worktree registration is absent, but its generated branch remains. Review the structured recovery details and remove the branch manually with a platform-appropriate Git client.",
    );
  }
}

export function cleanupFailureMessage(
  results: readonly PromiseSettledResult<void>[],
  prefix: string,
): string | null {
  const failures = [...new Set(results.flatMap((result) =>
    result.status === "rejected"
      ? [duoLaunchErrorMessage(result.reason)]
      : []))];
  return failures.length === 0 ? null : `${prefix}: ${failures.join(" ")}`;
}
