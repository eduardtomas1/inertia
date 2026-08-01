import { describe, expect, it } from "vitest";

import {
  mapWithinSourceControlDeadline,
  SourceControlDeadline,
} from "../../src/server/runtime/commands/source-control-deadline";

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

  it("aborts sibling work when a bounded phase exits early", async () => {
    const deadline = new SourceControlDeadline(Date.now() + 5_000, "read");
    const observedSignals: AbortSignal[] = [];
    try {
      await expect(deadline.run(async (signal) => {
        observedSignals.push(signal);
        return await Promise.all([
          Promise.reject(new Error("Primary Git read failed.")),
          new Promise<string>(() => undefined),
        ]);
      })).rejects.toThrow("Primary Git read failed.");
    } finally {
      deadline.dispose();
    }
    expect(observedSignals).toHaveLength(1);
    expect(observedSignals[0]?.aborted).toBe(true);
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
