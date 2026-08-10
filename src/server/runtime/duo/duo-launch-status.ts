import type {
  DuoGitRecoveryAction,
  DuoLaunchStatus,
  DuoWorktreeRecoveryGuidance,
} from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";

function recoveryGuidance(
  store: RuntimeStore,
  status: ReturnType<RuntimeStore["pairedLaunch"]>,
): DuoWorktreeRecoveryGuidance[] {
  if (status.state !== "recovery-required") return [];
  return status.plans.flatMap((plan): DuoWorktreeRecoveryGuidance[] => {
    if (
      !plan.ownsWorktree
      || !plan.plannedWorktreePath
      || !plan.plannedBranch
      || status.sides[plan.ordinal].conversationId
    ) return [];
    let topology: DuoWorktreeRecoveryGuidance["topology"];
    if (
      plan.worktreeCleanupOutcome === "absent"
      && plan.branchCleanupOutcome === "retained"
    ) {
      topology = "branch-retained";
    } else if (plan.worktreeCleanupOutcome === "retained") {
      topology = plan.worktreeCleanupTopology ?? "ambiguous";
    } else if (
      plan.worktreeCreationState === "creating"
      || plan.worktreeCreationState === "created"
    ) {
      topology = "ambiguous";
    } else {
      return [];
    }
    const cwd = store.projectPath(plan.projectId);
    const branchAction: DuoGitRecoveryAction = {
      label: "Remove generated branch after inspecting it",
      cwd,
      executable: "git",
      args: ["branch", "-d", "--", plan.plannedBranch],
    };
    const actions: DuoGitRecoveryAction[] = topology === "owned"
      && plan.cleanupObservedPath
      ? [
        {
          label: "Remove retained linked worktree",
          cwd,
          executable: "git",
          args: ["worktree", "remove", "--", plan.cleanupObservedPath],
        },
        branchAction,
      ]
      : topology === "branch-retained"
        ? [branchAction]
        : [];
    return [{
      kind: "git-worktree",
      ordinal: plan.ordinal,
      topology,
      repositoryPath: cwd,
      plannedPath: plan.plannedWorktreePath,
      observedPath: plan.cleanupObservedPath,
      worktreeId: plan.cleanupWorktreeId,
      generatedBranch: plan.plannedBranch,
      expectedHead: plan.cleanupBranchHead,
      observedBranch: plan.cleanupObservedBranch,
      observedHead: plan.cleanupObservedHead,
      actions,
    }];
  });
}

export function publicDuoLaunchStatus(
  store: RuntimeStore,
  status: ReturnType<RuntimeStore["pairedLaunch"]>,
): DuoLaunchStatus {
  return {
    launchId: status.launchId,
    state: status.state,
    cancelRequested: status.cancelRequested,
    error: status.error,
    sides: status.sides,
    ...(status.comparison
      ? {
          comparison: {
            state: status.comparison.state,
            conversationId: status.comparison.conversationId,
            turnId: status.comparison.turnId,
            attempt: status.comparison.attempt,
            error: status.comparison.error,
          },
        }
      : {}),
    recoveryGuidance: recoveryGuidance(store, status),
  };
}
