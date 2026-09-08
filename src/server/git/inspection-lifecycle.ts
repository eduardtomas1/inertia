import {
  GitError,
  isGitProcessTreeTerminationFailure,
} from "./types";

interface InspectionOptions {
  deadlineAt?: number;
  signal?: AbortSignal;
}

interface ActiveInspection {
  controller: AbortController;
  settlement: Promise<void>;
}

function cancelled(): GitError {
  return new GitError("timeout", "Git inspection was cancelled.");
}

function unavailable(options: InspectionOptions): boolean {
  return options.signal?.aborted === true
    || options.deadlineAt !== undefined && Date.now() >= options.deadlineAt;
}

/** Owns every read-only Git process from admission through tree settlement. */
export class GitInspectionLifecycle {
  private readonly active = new Set<ActiveInspection>();
  private holds = 0;
  private cleanupFailure: unknown;

  run<Result>(
    options: InspectionOptions,
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    if (this.cleanupFailure !== undefined) return Promise.reject(this.cleanupFailure);
    if (this.holds > 0 || unavailable(options)) return Promise.reject(cancelled());
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    const active: ActiveInspection = {
      controller,
      settlement: Promise.resolve(),
    };
    this.active.add(active);
    const result = Promise.resolve().then(async () => {
      if (controller.signal.aborted) throw cancelled();
      return await operation(controller.signal);
    }).finally(() => {
      options.signal?.removeEventListener("abort", cancel);
      controller.abort();
    });
    active.settlement = result.then(
      () => undefined,
      (error: unknown) => {
        // The caller owns result's rejection. Retain cleanup uncertainty for
        // shutdown without creating an independently unhandled rejection.
        if (isGitProcessTreeTerminationFailure(error)) this.cleanupFailure ??= error;
      },
    ).finally(() => { this.active.delete(active); });
    return result;
  }

  async cancelAndDrainWhile<Result>(operation: () => Promise<Result>): Promise<Result> {
    this.holds += 1;
    try {
      const [drain, operationResult] = await Promise.allSettled([
        this.cancelAndDrain(),
        Promise.resolve().then(operation),
      ]);
      if (drain.status === "rejected") throw drain.reason;
      if (operationResult.status === "rejected") throw operationResult.reason;
      return operationResult.value;
    } finally {
      this.holds -= 1;
    }
  }

  private async cancelAndDrain(): Promise<void> {
    while (this.active.size > 0) {
      const current = [...this.active];
      current.forEach(({ controller }) => controller.abort());
      await Promise.all(
        current.map(({ settlement }) => settlement),
      );
    }
    if (this.cleanupFailure !== undefined) throw this.cleanupFailure;
  }
}

export const gitInspectionLifecycle = new GitInspectionLifecycle();
