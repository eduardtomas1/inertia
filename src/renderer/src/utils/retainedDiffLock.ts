export type RetainedDiffLock = "refreshing" | "failed" | "stale" | null;

export interface RetainedDiffValidation {
  snapshot: object;
  identity: string;
}

export interface RetainedDiffLockInput {
  snapshot: object | null;
  identity: string | null;
  repositoryReady: boolean;
  statusLoading: boolean;
  statusError: string | null;
  statusStale: boolean;
  diffLoading: boolean;
  diffError: string | null;
  validatedFor: RetainedDiffValidation | null;
}

export function retainedDiffLock(input: RetainedDiffLockInput): RetainedDiffLock {
  if (input.statusError !== null || input.diffError !== null) return "failed";
  if (input.statusStale && !input.statusLoading) return "stale";
  if (input.statusLoading || input.diffLoading) return "refreshing";
  if (
    input.snapshot === null
    || input.identity === null
    || !input.repositoryReady
    || input.validatedFor?.identity !== input.identity
  ) return "stale";
  return input.validatedFor.snapshot === input.snapshot ? null : "refreshing";
}
