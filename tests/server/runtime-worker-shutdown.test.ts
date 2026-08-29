import { describe, expect, it, vi } from "vitest";

import type { RunningRuntime } from "../../src/server";
import {
  RUNTIME_SHUTDOWN_DEADLINE_MS,
  runRuntimeShutdownPhases,
} from "../../src/server/runtime-shutdown";
import { completeRuntimeWorkerShutdown } from "../../src/server/runtime-worker-shutdown";

function runtimeWithClose(
  close: RunningRuntime["close"],
): RunningRuntime {
  return {
    websocketUrl: "ws://127.0.0.1:1/runtime/test",
    databaseRecovery: {
      checkedAt: "2026-01-01T00:00:00.000Z",
      outcome: "healthy",
      trigger: "none",
      restoredBackup: null,
      preservedCorruptPrimary: false,
      preservedDatabaseFamilyMembers: 0,
      invalidBackupsSkipped: 0,
      unsupportedBackupsSkipped: 0,
    },
    recordSystemSuspendInterval: vi.fn(),
    prepareForUpdate: vi.fn(async () => ({ ready: true as const })),
    releaseUpdatePreparation: vi.fn(() => true),
    resolveProjectPath: vi.fn(),
    privateConnectRequest: vi.fn(async () => {
      throw new Error("unused");
    }),
    preparePrivateConnectPrompt: vi.fn(async () => {
      throw new Error("unused");
    }),
    commitPrivateConnectPrompt: vi.fn(() => {
      throw new Error("unused");
    }),
    forgetPrivateConnectTranscripts: vi.fn(),
    exportRecoveryData: vi.fn(async () => undefined),
    importRecoveryData: vi.fn(async () => ({
      projects: 0,
      conversations: 0,
      messages: 0,
      alreadyImported: false,
    })),
    close,
  };
}

describe("runtime worker shutdown", () => {
  it.runIf(process.platform === "darwin")(
    "allows delayed macOS guardian admission and retirement inside the shared deadline",
    async () => {
      vi.useFakeTimers();
      try {
        const post = vi.fn();
        const exit = vi.fn();
        const shutdown = completeRuntimeWorkerShutdown({
          runtime: runtimeWithClose(() => new Promise<void>((resolve) => {
            setTimeout(resolve, RUNTIME_SHUTDOWN_DEADLINE_MS - 250);
          })),
          cause: "runtime-shutdown",
          exitCode: 0,
          closeBrokers: vi.fn(),
          ownedProcessCleanupConfirmed: async () => true,
          post,
          awaitStoppedAcknowledgement: async () => undefined,
          exit,
        });

        await vi.advanceTimersByTimeAsync(RUNTIME_SHUTDOWN_DEADLINE_MS - 250);
        await shutdown;

        expect(RUNTIME_SHUTDOWN_DEADLINE_MS).toBe(10_000);
        expect(post).toHaveBeenCalledWith({ type: "runtime.stopped" });
        expect(post).not.toHaveBeenCalledWith({
          type: "runtime.shutdown-unconfirmed",
        });
        expect(exit).toHaveBeenCalledWith(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("reports stopped and exits only after runtime cleanup succeeds", async () => {
    const post = vi.fn();
    const exit = vi.fn();
    const closeBrokers = vi.fn();
    let acknowledgeStopped!: () => void;
    const stoppedAcknowledged = new Promise<void>((resolve) => {
      acknowledgeStopped = resolve;
    });

    const shutdown = completeRuntimeWorkerShutdown({
      runtime: runtimeWithClose(vi.fn(async () => undefined)),
      cause: "runtime-shutdown",
      exitCode: 0,
      closeBrokers,
      post,
      awaitStoppedAcknowledgement: () => stoppedAcknowledged,
      exit,
    });

    await vi.waitFor(() => {
      expect(post).toHaveBeenCalledWith({ type: "runtime.stopped" });
    });
    expect(closeBrokers).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    acknowledgeStopped();
    await shutdown;
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("keeps the utility alive when a late-started runtime cannot confirm cleanup", async () => {
    const post = vi.fn();
    const exit = vi.fn();
    const closeBrokers = vi.fn();

    await completeRuntimeWorkerShutdown({
      runtime: runtimeWithClose(vi.fn(async () => {
        throw new Error("terminal tree still alive");
      })),
      cause: "runtime-shutdown",
      exitCode: 0,
      closeBrokers,
      post,
      awaitStoppedAcknowledgement: async () => undefined,
      exit,
    });

    expect(closeBrokers).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith({
      type: "runtime.shutdown-unconfirmed",
    });
    expect(post).not.toHaveBeenCalledWith({ type: "runtime.stopped" });
    expect(exit).not.toHaveBeenCalled();
  });

  it("keeps the utility alive while an owned process claim remains", async () => {
    const post = vi.fn();
    const exit = vi.fn();

    await completeRuntimeWorkerShutdown({
      runtime: runtimeWithClose(vi.fn(async () => undefined)),
      cause: "runtime-shutdown",
      exitCode: 0,
      closeBrokers: vi.fn(),
      ownedProcessCleanupConfirmed: () => false,
      post,
      awaitStoppedAcknowledgement: async () => undefined,
      exit,
    });

    expect(post).toHaveBeenCalledWith({ type: "runtime.shutdown-unconfirmed" });
    expect(post).not.toHaveBeenCalledWith({ type: "runtime.stopped" });
    expect(exit).not.toHaveBeenCalled();
  });

  it("awaits a closing owned process claim before reporting stopped", async () => {
    const post = vi.fn();
    const exit = vi.fn();

    await completeRuntimeWorkerShutdown({
      runtime: runtimeWithClose(vi.fn(async () => undefined)),
      cause: "runtime-shutdown",
      exitCode: 0,
      closeBrokers: vi.fn(),
      ownedProcessCleanupConfirmed: () => new Promise<boolean>((resolve) => {
        queueMicrotask(() => resolve(true));
      }),
      post,
      awaitStoppedAcknowledgement: async () => undefined,
      exit,
    });

    expect(post).toHaveBeenCalledWith({ type: "runtime.stopped" });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("accepts completed cleanup when runtime close consumes the shared deadline", async () => {
    vi.useFakeTimers();
    try {
      const post = vi.fn();
      const exit = vi.fn();
      const shutdown = completeRuntimeWorkerShutdown({
        runtime: runtimeWithClose(() => new Promise<void>((resolve) => {
          setTimeout(resolve, RUNTIME_SHUTDOWN_DEADLINE_MS);
        })),
        cause: "runtime-shutdown",
        exitCode: 0,
        closeBrokers: vi.fn(),
        ownedProcessCleanupConfirmed: async () => true,
        post,
        awaitStoppedAcknowledgement: async () => undefined,
        exit,
      });

      await vi.advanceTimersByTimeAsync(RUNTIME_SHUTDOWN_DEADLINE_MS);
      await shutdown;
      expect(post).toHaveBeenCalledWith({ type: "runtime.stopped" });
      expect(post).not.toHaveBeenCalledWith({
        type: "runtime.shutdown-unconfirmed",
      });
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when a completed boundary cleanup check returns false", async () => {
    vi.useFakeTimers();
    try {
      const post = vi.fn();
      const exit = vi.fn();
      const shutdown = completeRuntimeWorkerShutdown({
        runtime: runtimeWithClose(() => new Promise<void>((resolve) => {
          setTimeout(resolve, RUNTIME_SHUTDOWN_DEADLINE_MS);
        })),
        cause: "runtime-shutdown",
        exitCode: 0,
        closeBrokers: vi.fn(),
        ownedProcessCleanupConfirmed: async () => false,
        post,
        awaitStoppedAcknowledgement: async () => undefined,
        exit,
      });

      await vi.advanceTimersByTimeAsync(RUNTIME_SHUTDOWN_DEADLINE_MS);
      await shutdown;
      expect(post).toHaveBeenCalledWith({
        type: "runtime.shutdown-unconfirmed",
      });
      expect(post).not.toHaveBeenCalledWith({ type: "runtime.stopped" });
      expect(exit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait beyond the runtime shutdown deadline for claim retirement", async () => {
    vi.useFakeTimers();
    try {
      const post = vi.fn();
      const exit = vi.fn();
      const shutdown = completeRuntimeWorkerShutdown({
        runtime: runtimeWithClose(vi.fn(async () => undefined)),
        cause: "runtime-shutdown",
        exitCode: 0,
        closeBrokers: vi.fn(),
        ownedProcessCleanupConfirmed: () => new Promise<boolean>(() => undefined),
        post,
        awaitStoppedAcknowledgement: async () => undefined,
        exit,
      });

      await vi.advanceTimersByTimeAsync(RUNTIME_SHUTDOWN_DEADLINE_MS);
      await shutdown;
      expect(post).toHaveBeenCalledWith({
        type: "runtime.shutdown-unconfirmed",
      });
      expect(exit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never reports stopped when an owned child misses the shutdown deadline", async () => {
    vi.useFakeTimers();
    try {
      const post = vi.fn();
      const exit = vi.fn();
      const closeBrokers = vi.fn();
      const shutdown = completeRuntimeWorkerShutdown({
        runtime: runtimeWithClose(() => runRuntimeShutdownPhases({
          independentDrains: [() => new Promise<void>(() => undefined)],
          stopIsolatedRuns: () => undefined,
          disposeTurnsAndProviders: () => undefined,
          settleArtifacts: () => undefined,
          terminateClients: () => undefined,
          closeServer: () => undefined,
          closeStore: () => undefined,
        }, 100)),
        cause: "runtime-shutdown",
        exitCode: 0,
        closeBrokers,
        post,
        awaitStoppedAcknowledgement: async () => undefined,
        exit,
      });

      await vi.advanceTimersByTimeAsync(100);
      await shutdown;
      expect(post).toHaveBeenCalledWith({
        type: "runtime.shutdown-unconfirmed",
      });
      expect(post).not.toHaveBeenCalledWith({ type: "runtime.stopped" });
      expect(exit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
