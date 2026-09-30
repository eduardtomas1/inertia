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

export type PosixCleanupRow =
  | PosixCleanupFailureReason
  | "ps-read-timed-out"
  | "stop-never-observed"
  | "running-then-gone"
  | "unknown-root-state"
  | "exit-not-observed";

export interface PosixCleanupDiagnostic extends PosixCleanupFailure {
  readonly row: PosixCleanupRow;
  readonly snapshotReads: number | null;
  readonly snapshotTimeouts: number | null;
  readonly elapsedMs: number;
}

function posixCleanupRow(
  failure: PosixCleanupFailure,
  snapshot: { snapshotReads: number; snapshotTimeouts: number } | null,
): PosixCleanupRow {
  if (failure.reason !== "exit-unconfirmed" && failure.reason !== "incomplete-scan") {
    return failure.reason;
  }
  const snapshotTimeouts = snapshot?.snapshotTimeouts ?? 0;
  if (failure.rootState === "unknown") {
    return snapshotTimeouts > 0 ? "ps-read-timed-out" : "unknown-root-state";
  }
  if (failure.rootState === "running") {
    return snapshot && snapshotTimeouts > 0 && snapshotTimeouts >= snapshot.snapshotReads - 1
      ? "ps-read-timed-out"
      : "stop-never-observed";
  }
  if (
    failure.rootRunningObserved === true
    && (failure.rootState === "zombie" || failure.rootState === "absent")
  ) return "running-then-gone";
  return "exit-not-observed";
}

export function posixCleanupDiagnostic(
  failure: PosixCleanupFailure,
  snapshot: { snapshotReads: number; snapshotTimeouts: number } | null,
  elapsedMs: number,
): PosixCleanupDiagnostic {
  return {
    ...failure,
    row: posixCleanupRow(failure, snapshot),
    snapshotReads: snapshot?.snapshotReads ?? null,
    snapshotTimeouts: snapshot?.snapshotTimeouts ?? null,
    elapsedMs: Math.max(0, Math.min(300_000, Math.trunc(elapsedMs))),
  };
}

export function describePosixCleanupDiagnostic(
  diagnostic: PosixCleanupDiagnostic,
): string {
  return `[POSIX cleanup ${diagnostic.row}: reason=${diagnostic.reason}`
    + ` rootStop=${diagnostic.rootStop} rootState=${diagnostic.rootState}`
    + ` rootRunningObserved=${diagnostic.rootRunningObserved}`
    + ` scanStabilized=${diagnostic.scanStabilized}`
    + ` groupExited=${diagnostic.groupExited}`
    + ` descendantsExited=${diagnostic.descendantsExited}`
    + ` rootExited=${diagnostic.rootExited}`
    + ` reads=${diagnostic.snapshotReads} timedOutReads=${diagnostic.snapshotTimeouts}`
    + ` elapsedMs=${diagnostic.elapsedMs}]`;
}
