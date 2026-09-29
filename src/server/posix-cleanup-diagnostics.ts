import type {
  PosixRootState,
  PosixRootStopResult,
} from "../node/posix-process-tree";

export type PosixCleanupFailureReason =
  | "invalid-pid"
  | "incomplete-scan"
  | "no-exit-budget"
  | "exit-unconfirmed"
  | "graceful-unconfirmed"
  | "closed-unconfirmed"
  | "owned-stop-unconfirmed";

export interface PosixCleanupFailure {
  readonly scope: "child" | "pid";
  readonly reason: PosixCleanupFailureReason;
  readonly rootStop: PosixRootStopResult | null;
  readonly rootState: PosixRootState | null;
  readonly rootRunningObserved: boolean | null;
  readonly scanStabilized: boolean | null;
  readonly groupExited: boolean | null;
  readonly descendantsExited: boolean | null;
  readonly rootExited: boolean | null;
}
