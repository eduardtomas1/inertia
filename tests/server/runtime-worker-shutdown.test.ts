import { describe, expect, it, vi } from "vitest";

import type { RunningRuntime } from "../../src/server";
import { runRuntimeShutdownPhases } from "../../src/server/runtime-shutdown";
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
      invalidBackupsSkipped: 0,
      unsupportedBackupsSkipped: 0,
    },
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
  it("reports stopped and exits only after runtime cleanup succeeds", async () => {
    const post = vi.fn();
    const exit = vi.fn();
    const closeBrokers = vi.fn();

    await completeRuntimeWorkerShutdown({
      runtime: runtimeWithClose(vi.fn(async () => undefined)),
      cause: "runtime-shutdown",
      exitCode: 0,
      closeBrokers,
      post,
      exit,
    });

    expect(closeBrokers).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith({ type: "runtime.stopped" });
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
      exit,
    });

    expect(closeBrokers).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith({
      type: "runtime.shutdown-unconfirmed",
    });
    expect(post).not.toHaveBeenCalledWith({ type: "runtime.stopped" });
    expect(exit).not.toHaveBeenCalled();
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
