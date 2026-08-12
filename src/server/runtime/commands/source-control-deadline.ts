import { GitError } from "../../git";
import {
  gitInspectionSettlementValues,
  isGitProcessTreeTerminationFailure,
} from "../../git/runner";

export type SourceControlDeadlineKind = "read" | "workspace-discovery";

function deadlineError(kind: SourceControlDeadlineKind): GitError {
  return kind === "workspace-discovery"
    ? new GitError(
      "timeout",
      "Workspace repository discovery took too long.",
    )
    : new GitError("timeout", "Git inspection took too long.");
}

/**
 * Gives filesystem authority checks the same aggregate deadline as the Git
 * work they protect. Operations are raced even when an injected broker does
 * not observe AbortSignal; callers still pass the signal so the real broker
 * can stop promptly and authority registries can refuse late commits.
 */
export class SourceControlDeadline {
  readonly signal: AbortSignal;

  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(
    readonly deadlineAt: number,
    private readonly kind: SourceControlDeadlineKind,
  ) {
    this.signal = this.controller.signal;
    this.timer = setTimeout(
      () => this.controller.abort(),
      Math.max(1, deadlineAt - Date.now()),
    );
  }

  async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return await this.runOperation(operation, false);
  }

  /**
   * Like run(), but retains ownership after the deadline aborts until the
   * operation settles. Use this only for operations whose cancellation path
   * is independently bounded, such as owned Git process-tree cleanup.
   */
  async runToSettlement<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return await this.runOperation(operation, true);
  }

  private async runOperation<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    retainOwnershipOnAbort: boolean,
  ): Promise<T> {
    this.requireTime();
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      let deadlineReached = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        this.signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = (): void => {
        deadlineReached = true;
        if (retainOwnershipOnAbort) return;
        finish(() => reject(deadlineError(this.kind)));
      };
      this.signal.addEventListener("abort", onAbort, { once: true });
      const settleOperation = (result: PromiseSettledResult<T>): void => {
        finish(() => {
          if (
            deadlineReached
            || this.signal.aborted
            || Date.now() >= this.deadlineAt
          ) {
            this.controller.abort();
            if (
              retainOwnershipOnAbort
              && result.status === "rejected"
              && isGitProcessTreeTerminationFailure(result.reason)
            ) {
              reject(result.reason);
            } else {
              reject(deadlineError(this.kind));
            }
          } else if (result.status === "rejected") {
            reject(result.reason);
          } else {
            resolve(result.value);
          }
        });
      };
      let pending: Promise<T>;
      try {
        pending = operation(this.signal);
      } catch (error) {
        settleOperation({ status: "rejected", reason: error });
        return;
      }
      void pending.then(
        (value) => settleOperation({ status: "fulfilled", value }),
        (reason: unknown) => settleOperation({ status: "rejected", reason }),
      );
    });
  }

  requireTime(): void {
    if (this.signal.aborted || Date.now() >= this.deadlineAt) {
      this.controller.abort();
      throw deadlineError(this.kind);
    }
  }

  cancel(): void {
    this.controller.abort();
  }

  dispose(): void {
    this.controller.abort();
    clearTimeout(this.timer);
  }
}

/**
 * Runs two sibling Git inspections under one cancellation signal. If either
 * inspection rejects, cancel the other and retain ownership until both have
 * settled so no child process can outlive the aggregate operation.
 */
export async function settleSourceControlInspections<First, Second>(
  signal: AbortSignal,
  first: (signal: AbortSignal) => Promise<First>,
  second: (signal: AbortSignal) => Promise<Second>,
): Promise<[First, Second]> {
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  let firstFailure: 0 | 1 | undefined;

  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });

  const runInspection = async <T>(
    index: 0 | 1,
    inspection: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    try {
      return await inspection(controller.signal);
    } catch (error) {
      firstFailure ??= index;
      cancel();
      throw error;
    }
  };

  try {
    const [firstResult, secondResult] = await Promise.allSettled([
      runInspection(0, first),
      runInspection(1, second),
    ] as const);
    if (firstFailure === 1) {
      const [second, first] = gitInspectionSettlementValues([
        secondResult,
        firstResult,
      ]);
      return [first, second];
    }
    return gitInspectionSettlementValues([firstResult, secondResult]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function mapWithinSourceControlDeadline<T, R>(
  values: readonly T[],
  concurrency: number,
  deadline: SourceControlDeadline,
  project: (value: T, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: values.length });
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      for (;;) {
        deadline.requireTime();
        const index = cursor++;
        if (index >= values.length) return;
        results[index] = await deadline.run(
          async (signal) => await project(values[index]!, signal),
        );
      }
    },
  );
  try {
    await Promise.all(workers);
    return results;
  } catch (error) {
    deadline.cancel();
    await Promise.allSettled(workers);
    throw error;
  }
}
