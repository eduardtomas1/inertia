import { GitError } from "../../git";

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
    this.requireTime();
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        this.signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = (): void => {
        finish(() => reject(deadlineError(this.kind)));
      };
      this.signal.addEventListener("abort", onAbort, { once: true });
      void operation(this.signal).then(
        (value) => finish(() => {
          if (this.signal.aborted || Date.now() >= this.deadlineAt) {
            this.controller.abort();
            reject(deadlineError(this.kind));
          } else {
            resolve(value);
          }
        }),
        (error: unknown) => finish(() => {
          if (this.signal.aborted || Date.now() >= this.deadlineAt) {
            this.controller.abort();
            reject(deadlineError(this.kind));
          } else {
            reject(error);
          }
        }),
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
