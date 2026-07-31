import { describe, expect, it, vi } from "vitest";

import {
  runRuntimeShutdownPhases,
  RuntimeShutdownDeadlineError,
} from "../../src/server/runtime-shutdown";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("runtime shutdown phases", () => {
  it("overlaps independent near-timeout drains within one shutdown deadline", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const slowDrain = (name: string) => async (): Promise<void> => {
        calls.push(`${name}:start`);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 2_000);
        });
        calls.push(`${name}:done`);
      };
      const shutdown = runRuntimeShutdownPhases({
        independentDrains: [
          slowDrain("terminal"),
          slowDrain("provider"),
        ],
        stopIsolatedRuns: () => { calls.push("isolated"); },
        disposeTurnsAndProviders: () => { calls.push("turns"); },
        settleArtifacts: () => { calls.push("artifacts"); },
        terminateClients: () => { calls.push("clients"); },
        closeServer: () => { calls.push("server"); },
        closeStore: () => { calls.push("store"); },
      });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(calls).toEqual([
        "terminal:start",
        "provider:start",
        "isolated",
        "turns",
      ]);

      await vi.advanceTimersByTimeAsync(1);
      await expect(shutdown).resolves.toBeUndefined();
      expect(calls).toEqual([
        "terminal:start",
        "provider:start",
        "isolated",
        "turns",
        "terminal:done",
        "provider:done",
        "artifacts",
        "clients",
        "server",
        "store",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never closes server or store while an owned-resource drain is active", async () => {
    vi.useFakeTimers();
    try {
      const first = deferred();
      const second = deferred();
      const calls: string[] = [];
      const shutdown = runRuntimeShutdownPhases({
        independentDrains: [
          () => first.promise,
          () => second.promise,
        ],
        stopIsolatedRuns: () => {},
        disposeTurnsAndProviders: () => {},
        settleArtifacts: () => { calls.push("artifacts"); },
        terminateClients: () => { calls.push("clients"); },
        closeServer: () => { calls.push("server"); },
        closeStore: () => { calls.push("store"); },
      });

      first.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toEqual([]);

      const rejected = expect(shutdown).rejects.toBeInstanceOf(
        RuntimeShutdownDeadlineError,
      );
      await vi.advanceTimersByTimeAsync(2_500);
      await rejected;
      expect(calls).toEqual([]);

      second.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("observes settled cleanup after a delayed event-loop resume", async () => {
    const now = vi.spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(10_000);
    const calls: string[] = [];
    try {
      await expect(runRuntimeShutdownPhases({
        independentDrains: [],
        stopIsolatedRuns: () => { calls.push("isolated"); },
        disposeTurnsAndProviders: () => { calls.push("turns"); },
        settleArtifacts: () => { calls.push("artifacts"); },
        terminateClients: () => { calls.push("clients"); },
        closeServer: async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          calls.push("server");
        },
        closeStore: () => { calls.push("store"); },
      }, 100)).resolves.toBeUndefined();
      expect(calls).toEqual([
        "isolated",
        "turns",
        "artifacts",
        "clients",
        "server",
        "store",
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it("identifies the active cleanup phase when a deadline expires", async () => {
    vi.useFakeTimers();
    try {
      const shutdown = runRuntimeShutdownPhases({
        independentDrains: [() => new Promise<void>(() => undefined)],
        stopIsolatedRuns: () => {},
        disposeTurnsAndProviders: () => {},
        settleArtifacts: () => {},
        terminateClients: () => {},
        closeServer: () => {},
        closeStore: () => {},
      }, 100);
      const rejected = expect(shutdown).rejects.toMatchObject({
        name: "RuntimeShutdownDeadlineError",
        phase: "owned-resource cleanup",
      });
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the first settled error while attempting every safe later phase", async () => {
    const firstError = new Error("terminal cleanup failed");
    const calls: string[] = [];

    await expect(runRuntimeShutdownPhases({
      independentDrains: [
        () => { throw firstError; },
        () => { calls.push("provider"); },
      ],
      stopIsolatedRuns: () => { calls.push("isolated"); },
      disposeTurnsAndProviders: () => { calls.push("turns"); },
      settleArtifacts: () => { calls.push("artifacts"); },
      terminateClients: () => { calls.push("clients"); },
      closeServer: () => { calls.push("server"); },
      closeStore: () => { calls.push("store"); },
    })).rejects.toBe(firstError);

    expect(calls).toEqual([
      "provider",
      "isolated",
      "turns",
      "artifacts",
      "clients",
      "server",
      "store",
    ]);
  });

  it("settles isolated provider ownership before disposing the shared provider manager", async () => {
    const isolatedFinished = deferred();
    const calls: string[] = [];
    const disposeAll = vi.fn(() => {
      expect(calls).toContain("isolated:finished");
      calls.push("provider-manager:disposeAll");
    });
    const shutdown = runRuntimeShutdownPhases({
      independentDrains: [],
      stopIsolatedRuns: async () => {
        calls.push("isolated:stopOwned");
        await isolatedFinished.promise;
        calls.push("isolated:finished");
      },
      disposeTurnsAndProviders: disposeAll,
      settleArtifacts: () => {},
      terminateClients: () => {},
      closeServer: () => {},
      closeStore: () => {},
    });

    await Promise.resolve();
    expect(calls).toEqual(["isolated:stopOwned"]);
    expect(disposeAll).not.toHaveBeenCalled();

    isolatedFinished.resolve();
    await expect(shutdown).resolves.toBeUndefined();
    expect(calls).toEqual([
      "isolated:stopOwned",
      "isolated:finished",
      "provider-manager:disposeAll",
    ]);
    expect(disposeAll).toHaveBeenCalledOnce();
  });
});
