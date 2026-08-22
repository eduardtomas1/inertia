import { describe, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
  stalledPath: "/stalled-repository",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: vi.fn(async (path: Parameters<typeof actual.realpath>[0]) => {
      if (String(path) === filesystem.stalledPath) {
        return await new Promise<string>(() => undefined);
      }
      return await actual.realpath(path);
    }),
  };
});

import { GitError } from "../../src/server/git/types";
import { repositoryRoot, sameFilesystemPath } from "../../src/server/git/paths";
import {
  settleSourceControlInspections,
  SourceControlDeadline,
} from "../../src/server/runtime/commands/source-control-deadline";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("source-control inspection settlement", () => {
  it("bounds a stalled path inspection after sibling Git cleanup settles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T10:00:00.000Z"));
    const deadline = new SourceControlDeadline(Date.now() + 100, "read");
    const cleanupStarted = deferred();
    const releaseCleanup = deferred();
    let aggregateSettled = false;
    try {
      const aggregate = deadline.runToSettlement(
        async (signal) => await settleSourceControlInspections(
          signal,
          async (inspectionSignal) => await repositoryRoot(
            filesystem.stalledPath,
            { deadlineAt: deadline.deadlineAt, signal: inspectionSignal },
          ),
          async (inspectionSignal) => {
            if (!inspectionSignal.aborted) {
              await new Promise<void>((resolve) => {
                inspectionSignal.addEventListener(
                  "abort",
                  () => resolve(),
                  { once: true },
                );
              });
            }
            cleanupStarted.resolve();
            await releaseCleanup.promise;
            throw new GitError("timeout", "Git inspection was cancelled.");
          },
        ),
      );
      void aggregate.then(
        () => { aggregateSettled = true; },
        () => { aggregateSettled = true; },
      );

      await vi.advanceTimersByTimeAsync(100);
      await cleanupStarted.promise;
      expect(aggregateSettled).toBe(false);

      releaseCleanup.resolve();
      await expect(aggregate).rejects.toThrow("Git inspection took too long.");
      expect(aggregateSettled).toBe(true);
    } finally {
      releaseCleanup.resolve();
      deadline.dispose();
      vi.useRealTimers();
    }
  });

  it("bounds stalled alias-path revalidation with the aggregate signal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T10:00:00.000Z"));
    const deadline = new SourceControlDeadline(Date.now() + 100, "read");
    try {
      const comparison = deadline.runToSettlement(
        async (signal) => await sameFilesystemPath(
          filesystem.stalledPath,
          "/",
          { deadlineAt: deadline.deadlineAt, signal },
        ),
      );
      const timedOut = expect(comparison).rejects.toThrow(
        "Git inspection took too long.",
      );

      await vi.advanceTimersByTimeAsync(100);

      await timedOut;
    } finally {
      deadline.dispose();
      vi.useRealTimers();
    }
  });
});
