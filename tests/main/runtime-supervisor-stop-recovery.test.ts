// @inertia-test-suite portable

import { describe, expect, it } from "vitest";

import {
  reconcileStoppedRuntimeQuarantine,
  runtimeStopAttemptState,
  trackRuntimeStopAttempt,
} from "../../src/main/runtime-supervisor-stop-recovery";

describe("Linux stopped-runtime recovery admission", () => {
  it("makes only an unsuccessful Linux stop retryable", async () => {
    const linux = runtimeStopAttemptState(true);
    await expect(trackRuntimeStopAttempt(linux, Promise.resolve(false)))
      .resolves.toBe(false);
    expect(linux).toMatchObject({ promise: null, retryEligible: true });

    const darwin = runtimeStopAttemptState(false);
    const stopped = trackRuntimeStopAttempt(darwin, Promise.resolve(false));
    await expect(stopped).resolves.toBe(false);
    expect(darwin.promise).toBe(stopped);
    expect(darwin.retryEligible).toBe(false);
  });

  it("releases a rejected Linux stop attempt without hiding its error", async () => {
    const state = runtimeStopAttemptState(true);
    const tracked = trackRuntimeStopAttempt(
      state,
      Promise.reject(new Error("shutdown rejected")),
    );
    await expect(tracked).rejects.toThrow("shutdown rejected");
    expect(state).toMatchObject({ promise: null, retryEligible: true });
  });

  it("defensively refuses quarantine reconciliation outside Linux", async () => {
    const result = reconcileStoppedRuntimeQuarantine({
      enabled: false,
      records: new Set(),
      drain: async () => true,
      recoverOwnedProcesses: () => true,
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
      recoveryWaitMs: 1,
      cleanupReceipts: {} as never,
      runtimeGenerationLeases: {} as never,
      runtimeOwnedProcesses: {} as never,
      onPersistenceFailure: () => undefined,
      clear: () => undefined,
    });
    await expect(result).resolves.toBe(false);
  });
});
