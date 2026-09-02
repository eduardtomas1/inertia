import { describe, expect, it, vi } from "vitest";

import { createTestPrivilegedCleanupController } from
  "../../src/main/test-privileged-cleanup-controller";

describe("test privileged-cleanup controller", () => {
  it("captures one cleanup receipt before permitting deferred exit", async () => {
    vi.useFakeTimers();
    try {
      let releaseCleanup!: (confirmed: boolean) => void;
      const cleanup = vi.fn(() => new Promise<boolean>((resolve) => {
        releaseCleanup = resolve;
      }));
      const exit = vi.fn();
      const controller = createTestPrivilegedCleanupController({
        runtimePid: () => 777,
        cleanup,
        exit,
      });

      const preparation = controller.preparePrivilegedCleanup();
      expect(controller.preparePrivilegedCleanup()).toBe(preparation);
      expect(controller.privilegedCleanupSnapshot()).toEqual({
        phase: "privileged-cleanup",
        runtimePid: 777,
        cleanupConfirmed: null,
        errorMessage: null,
      });
      expect(() => controller.finishPreparedQuit()).toThrow(
        "Cannot finish the test quit without confirmed privileged cleanup (phase=privileged-cleanup, cleanupConfirmed=null).",
      );

      releaseCleanup(true);
      await expect(preparation).resolves.toMatchObject({
        phase: "privileged-cleanup-complete",
        cleanupConfirmed: true,
      });
      expect(controller.finishPreparedQuit()).toMatchObject({
        phase: "exit-requested",
        runtimePid: 777,
      });
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains a useful phase and message when cleanup rejects", async () => {
    const controller = createTestPrivilegedCleanupController({
      runtimePid: () => 888,
      cleanup: async () => { throw new Error("cleanup failed"); },
      exit: vi.fn(),
    });

    await expect(controller.preparePrivilegedCleanup()).rejects.toThrow(
      "cleanup failed",
    );
    expect(controller.privilegedCleanupSnapshot()).toEqual({
      phase: "privileged-cleanup-failed",
      runtimePid: 888,
      cleanupConfirmed: false,
      errorMessage: "cleanup failed",
    });
  });

  it("does not permit normal exit when cleanup is unconfirmed", async () => {
    const exit = vi.fn();
    const controller = createTestPrivilegedCleanupController({
      runtimePid: () => 999,
      cleanup: async () => false,
      exit,
    });

    await expect(controller.preparePrivilegedCleanup()).resolves.toMatchObject({
      phase: "privileged-cleanup-complete",
      cleanupConfirmed: false,
    });
    expect(() => controller.finishPreparedQuit()).toThrow(
      "Cannot finish the test quit without confirmed privileged cleanup (phase=privileged-cleanup-complete, cleanupConfirmed=false).",
    );
    expect(exit).not.toHaveBeenCalled();
  });
});
