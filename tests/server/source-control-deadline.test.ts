import { describe, expect, it } from "vitest";

import {
  mapWithinSourceControlDeadline,
  settleSourceControlInspections,
  SourceControlDeadline,
} from "../../src/server/runtime/commands/source-control-deadline";
import { GitError } from "../../src/server/git/types";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("source-control aggregate deadlines", () => {
  it("rejects an overdue fulfillment before a delayed timer can run", async () => {
    const deadline = new SourceControlDeadline(Date.now() + 5, "read");
    try {
      await expect(deadline.run(async () => {
        const releaseAt = Date.now() + 15;
        while (Date.now() < releaseAt) {
          // Keep the event loop occupied so the timer cannot be the guard.
        }
        return "late";
      })).rejects.toThrow("Git inspection took too long.");
    } finally {
      deadline.dispose();
    }
  });

  it("cancels and settles a sibling inspection before rejecting", async () => {
    const controller = new AbortController();
    const firstCancelled = deferred<void>();
    const releaseFirst = deferred<void>();
    const primaryFailure = new Error("Repository status failed.");
    const cancellation = new GitError(
      "timeout",
      "Git inspection was cancelled.",
    );
    let firstAborted = false;
    let aggregateSettled = false;

    const aggregate = settleSourceControlInspections(
      controller.signal,
      async (signal) => {
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        firstAborted = signal.aborted;
        firstCancelled.resolve();
        await releaseFirst.promise;
        throw cancellation;
      },
      () => { throw primaryFailure; },
    );
    void aggregate.then(
      () => { aggregateSettled = true; },
      () => { aggregateSettled = true; },
    );

    await firstCancelled.promise;
    expect(firstAborted).toBe(true);
    expect(aggregateSettled).toBe(false);

    releaseFirst.resolve();
    await expect(aggregate).rejects.toBe(primaryFailure);
    expect(aggregateSettled).toBe(true);
  });

  it("prioritizes failed process cleanup after sibling cancellation", async () => {
    const controller = new AbortController();
    const secondStarted = deferred<void>();
    const cleanupFailure = new GitError(
      "operation-failed",
      "Git stopped responding, and its process tree could not be confirmed stopped.",
    );

    await expect(settleSourceControlInspections(
      controller.signal,
      async () => {
        await secondStarted.promise;
        throw new Error("Diff inspection failed.");
      },
      async (signal) => {
        secondStarted.resolve();
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        throw cleanupFailure;
      },
    )).rejects.toBe(cleanupFailure);
  });

  it("aborts and rejects a filesystem operation that does not settle", async () => {
    const deadline = new SourceControlDeadline(
      Date.now() + 20,
      "read",
    );
    const observedSignals: AbortSignal[] = [];
    try {
      await expect(deadline.run(async (signal) => {
        observedSignals.push(signal);
        return await new Promise<string>(() => undefined);
      })).rejects.toThrow("Git inspection took too long.");
      expect(observedSignals).toHaveLength(1);
      expect(observedSignals[0]?.aborted).toBe(true);
    } finally {
      deadline.dispose();
    }
  });

  it("stops bounded authority workers when workspace discovery expires", async () => {
    const deadline = new SourceControlDeadline(
      Date.now() + 20,
      "workspace-discovery",
    );
    const held = deferred<number>();
    const started: number[] = [];
    try {
      await expect(mapWithinSourceControlDeadline(
        [0, 1, 2, 3, 4, 5],
        2,
        deadline,
        async (value) => {
          started.push(value);
          return await held.promise;
        },
      )).rejects.toThrow("Workspace repository discovery took too long.");
      expect(started).toEqual([0, 1]);
      expect(deadline.signal.aborted).toBe(true);
    } finally {
      held.resolve(1);
      deadline.dispose();
    }
  });
});
