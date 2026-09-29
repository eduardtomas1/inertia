import type {
  PosixRootState,
  PosixRootStopResult,
} from "../node/posix-process-tree";

export interface PosixCleanupFailure {
  readonly scope: "child" | "pid";
  readonly rootStop: PosixRootStopResult;
  readonly rootState: PosixRootState;
  readonly scanStabilized: boolean;
  readonly groupExited: boolean | null;
  readonly descendantsExited: boolean | null;
  readonly rootExited: boolean | null;
}

const failures: PosixCleanupFailure[] = [];

export function recordPosixCleanupFailure(failure: PosixCleanupFailure): void {
  failures.push({ ...failure });
  if (failures.length > 8) failures.shift();
}

export function posixCleanupFailures(): PosixCleanupFailure[] {
  return failures.map((failure) => ({ ...failure }));
}
