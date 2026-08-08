export const DUO_LAUNCH_STATES = [
  "preparing",
  "prepared",
  "dispatching",
  "running",
  "cancelled",
  "failed",
  "interrupted",
  "recovery-required",
] as const;

export type DuoLaunchState = typeof DUO_LAUNCH_STATES[number];

export const DUO_DISPATCH_STATES = [
  "pending",
  "claimed",
  "started",
  "failed",
  "cancelled",
  "uncertain",
] as const;

export type DuoDispatchState = typeof DUO_DISPATCH_STATES[number];

export const DUO_COMPARISON_STATES = [
  "waiting",
  "dispatching",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type DuoComparisonState = typeof DUO_COMPARISON_STATES[number];

export interface DuoComparisonStatus {
  state: DuoComparisonState;
  conversationId: string | null;
  turnId: string | null;
  attempt: number;
  error: string | null;
}

export interface DuoLaunchSideStatus {
  ordinal: 0 | 1;
  conversationId: string | null;
  turnId: string | null;
  dispatchState: DuoDispatchState;
}

export interface DuoGitRecoveryAction {
  label: string;
  cwd: string;
  executable: "git";
  args: string[];
}

export interface DuoWorktreeRecoveryGuidance {
  kind: "git-worktree";
  ordinal: 0 | 1;
  topology: "owned" | "conflict" | "ambiguous" | "branch-retained";
  repositoryPath: string;
  plannedPath: string;
  observedPath: string | null;
  worktreeId: string | null;
  generatedBranch: string;
  expectedHead: string | null;
  observedBranch: string | null;
  observedHead: string | null;
  actions: DuoGitRecoveryAction[];
}

export interface DuoLaunchStatus {
  launchId: string;
  state: DuoLaunchState;
  error: string | null;
  sides: [DuoLaunchSideStatus, DuoLaunchSideStatus];
  comparison?: DuoComparisonStatus;
  recoveryGuidance?: DuoWorktreeRecoveryGuidance[];
}

export interface DuoPreparedSide {
  ordinal: 0 | 1;
  conversationId: string;
  turnId: string;
}

export interface DuoPreparedResult {
  kind: "duo.prepared";
  launchId: string;
  state: "prepared";
  sides: [DuoPreparedSide, DuoPreparedSide];
  comparison?: {
    conversationId: string;
  };
}

export type DuoStatusResult = DuoLaunchStatus & { kind: "duo.status" };

export interface DuoPendingResult {
  kind: "duo.pending";
  launchIds: string[];
  hasMore: boolean;
}
