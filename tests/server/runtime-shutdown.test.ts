import { describe, expect, it, vi } from "vitest";

import {
  runtimeShutdownDeadlineMs,
  runtimeSupervisorRecoveryWaitMs,
  runtimeSupervisorShutdownEnvelopeMs,
} from "../../src/node/runtime-shutdown-deadline";
import {
  RUNTIME_SHUTDOWN_DEADLINE_MS,
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
  it("preserves each platform's complete cleanup proof window", () => {
    expect(runtimeShutdownDeadlineMs("darwin")).toBe(12_750);
    expect(runtimeShutdownDeadlineMs("linux")).toBe(12_000);
    expect(runtimeShutdownDeadlineMs("win32")).toBe(5_500);
    expect(runtimeSupervisorRecoveryWaitMs("darwin")).toBe(2_000);
    expect(runtimeSupervisorRecoveryWaitMs("linux")).toBe(2_000);
    expect(runtimeSupervisorRecoveryWaitMs("win32")).toBe(3_000);
    expect(runtimeSupervisorShutdownEnvelopeMs("darwin")).toBe(17_250);
    expect(runtimeSupervisorShutdownEnvelopeMs("linux")).toBe(16_500);
    expect(runtimeSupervisorShutdownEnvelopeMs("win32")).toBe(11_000);
  });

  it("reserves Linux post-terminal headroom for ordered cleanup", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const delayed = (name: string, delayMs: number) => async (): Promise<void> => {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        calls.push(name);
      };
      const shutdown = runRuntimeShutdownPhases({
        independentDrains: [delayed("terminal", 9_500)],
        stopIsolatedRuns: delayed("isolated", 0),
        disposeTurnsAndProviders: delayed("providers", 0),
        settleArtifacts: delayed("artifacts", 500),
        terminateClients: delayed("clients", 500),
        closeServer: delayed("server", 500),
        closeStore: delayed("store", 500),
      }, runtimeShutdownDeadlineMs("linux"));

      await vi.advanceTimersByTimeAsync(11_500);
      await shutdown;

      expect(calls).toEqual([
        "isolated",
        "providers",
        "terminal",
        "artifacts",
        "clients",
        "server",
        "store",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.runIf(process.platform === "darwin")(
    "reserves post-terminal headroom for ordered server and store cleanup",
    async () => {
      vi.useFakeTimers();
      try {
        const calls: string[] = [];
        const delayed = (name: string, delayMs: number) => async (): Promise<void> => {
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
          calls.push(name);
        };
        const shutdown = runRuntimeShutdownPhases({
          independentDrains: [delayed("terminal", 10_500)],
          stopIsolatedRuns: delayed("isolated", 0),
          disposeTurnsAndProviders: delayed("providers", 0),
          settleArtifacts: delayed("artifacts", 250),
          terminateClients: delayed("clients", 250),
          closeServer: delayed("server", 250),
          closeStore: delayed("store", 250),
        });

        await vi.advanceTimersByTimeAsync(11_500);
        await shutdown;

        expect(calls).toEqual([
          "isolated",
          "providers",
          "terminal",
          "artifacts",
          "clients",
          "server",
          "store",
        ]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("passes one absolute deadline through every shutdown phase", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const deadlines: number[] = [];
      const observe = ({ deadlineAt }: { deadlineAt: number }): void => {
        deadlines.push(deadlineAt);
      };
      await runRuntimeShutdownPhases({
        quiesceRuntimeWork: observe,
        independentDrains: [observe, observe],
        stopIsolatedRuns: observe,
        disposeTurnsAndProviders: observe,
        settleArtifacts: observe,
        terminateClients: observe,
        closeServer: observe,
        closeStore: observe,
      }, 100);

      expect(deadlines).toEqual(Array.from({ length: 9 }, () => 1_100));
    } finally {
      vi.useRealTimers();
    }
  });

  it("quiesces command admission before disposing owned resources", async () => {
    const command = deferred();
    const calls: string[] = [];
    const shutdown = runRuntimeShutdownPhases({
      quiesceRuntimeWork: async () => {
        calls.push("commands:start");
        await command.promise;
        calls.push("commands:done");
      },
      independentDrains: [() => { calls.push("terminals"); }],
      stopIsolatedRuns: () => { calls.push("isolated"); },
      disposeTurnsAndProviders: () => { calls.push("turns"); },
      settleArtifacts: () => {},
      terminateClients: () => {},
      closeServer: () => {},
      closeStore: () => {},
    });

    await Promise.resolve();
    expect(calls).toEqual(["commands:start"]);
    command.resolve();
    await expect(shutdown).resolves.toBeUndefined();
    expect(calls).toEqual([
      "commands:start",
      "commands:done",
      "terminals",
      "isolated",
      "turns",
    ]);
  });

  it("fails closed when command cleanup outlives the shutdown deadline", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const shutdown = runRuntimeShutdownPhases({
        quiesceRuntimeWork: () => new Promise<void>(() => undefined),
        independentDrains: [() => { calls.push("terminals"); }],
        stopIsolatedRuns: () => { calls.push("isolated"); },
        disposeTurnsAndProviders: () => { calls.push("turns"); },
        settleArtifacts: () => {},
        terminateClients: () => {},
        closeServer: () => {},
        closeStore: () => {},
      }, 100);
      const rejected = expect(shutdown).rejects.toMatchObject({
        name: "RuntimeShutdownDeadlineError",
        phase: "runtime command cleanup",
      });
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

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
      await vi.advanceTimersByTimeAsync(RUNTIME_SHUTDOWN_DEADLINE_MS);
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
    ]);
  });

  it("keeps the database open when turn and provider cleanup is unconfirmed", async () => {
    const cleanupError = new Error("provider cleanup is unconfirmed");
    const calls: string[] = [];

    await expect(runRuntimeShutdownPhases({
      independentDrains: [],
      stopIsolatedRuns: () => { calls.push("isolated"); },
      disposeTurnsAndProviders: () => {
        calls.push("turns");
        throw cleanupError;
      },
      settleArtifacts: () => { calls.push("artifacts"); },
      terminateClients: () => { calls.push("clients"); },
      closeServer: () => { calls.push("server"); },
      closeStore: () => { calls.push("store"); },
    })).rejects.toBe(cleanupError);

    expect(calls).toEqual([
      "isolated",
      "turns",
      "artifacts",
      "clients",
      "server",
    ]);
  });

  it("keeps the database open when artifact process cleanup is unconfirmed", async () => {
    const cleanupError = new Error("artifact process cleanup is unconfirmed");
    const calls: string[] = [];

    await expect(runRuntimeShutdownPhases({
      independentDrains: [],
      stopIsolatedRuns: () => { calls.push("isolated"); },
      disposeTurnsAndProviders: () => { calls.push("turns"); },
      settleArtifacts: () => {
        calls.push("artifacts");
        throw cleanupError;
      },
      terminateClients: () => { calls.push("clients"); },
      closeServer: () => { calls.push("server"); },
      closeStore: () => { calls.push("store"); },
    })).rejects.toBe(cleanupError);

    expect(calls).toEqual([
      "isolated",
      "turns",
      "artifacts",
      "clients",
      "server",
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
