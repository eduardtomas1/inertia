// @inertia-test-suite portable

import { describe, expect, it, vi } from "vitest";

import {
  reconcileStoppedRuntimeQuarantine,
  runtimePriorCleanupEvidence,
  runtimeStopAttemptState,
  trackRuntimeStopAttempt,
} from "../../src/main/runtime-supervisor-stop-recovery";
import { createRuntimeProcessRecord } from "../../src/main/runtime-supervisor-process-record";

describe("prior runtime cleanup evidence", () => {
  const record = (generation: number, exited: boolean) => ({
    ...createRuntimeProcessRecord({
      child: {} as never,
      generation,
      runtimeGenerationId: `00000000-0000-4000-8000-000000000001:${generation}`,
      cleanupReceiptIds: [],
    }),
    exited,
  });

  it("names exited generations and locks only for a worker whose exit was not observed", () => {
    expect(runtimePriorCleanupEvidence([])).toEqual({});
    expect(runtimePriorCleanupEvidence([record(1, true), record(2, true)])).toEqual({
      exitedUnconfirmedRuntimeGenerationIds: [
        "00000000-0000-4000-8000-000000000001:1",
        "00000000-0000-4000-8000-000000000001:2",
      ],
    });
    expect(runtimePriorCleanupEvidence([record(1, true), record(2, false)])).toEqual({
      priorRuntimeCleanupUnconfirmed: true,
      exitedUnconfirmedRuntimeGenerationIds: ["00000000-0000-4000-8000-000000000001:1"],
    });
  });

  it("locks instead of naming more exited generations than the worker accepts", () => {
    const records = Array.from({ length: 33 }, (_, index) => record(index + 1, true));
    expect(runtimePriorCleanupEvidence(records.slice(0, 32))
      .exitedUnconfirmedRuntimeGenerationIds).toHaveLength(32);
    expect(runtimePriorCleanupEvidence(records)).toEqual({
      priorRuntimeCleanupUnconfirmed: true,
    });
  });

  it("retires every generation reconciliation confirms even after one it cannot", async () => {
    const stuck = { ...record(1, true), generationCleanupConfirmed: true };
    const confirmed = {
      ...record(2, true), cleanupConfirmed: true, generationCleanupConfirmed: true,
    };
    const records = new Set([stuck, confirmed]);
    const clear = vi.fn();
    await expect(reconcileStoppedRuntimeQuarantine({
      records,
      drain: async (candidate) => candidate === confirmed,
      recoverOwnedProcesses: () => false,
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
      recoveryWaitMs: 1_000,
      cleanupReceipts: {} as never,
      runtimeGenerationLeases: {} as never,
      runtimeOwnedProcesses: {} as never,
      onPersistenceFailure: vi.fn(),
      clear,
    })).resolves.toBe(false);
    expect([...records]).toEqual([stuck]);
    expect(clear).toHaveBeenCalledExactlyOnceWith(confirmed);
  });
});

describe("stopped-runtime recovery admission", () => {
  it("makes only an unsuccessful stop retryable", async () => {
    const state = runtimeStopAttemptState();
    const confirmed = trackRuntimeStopAttempt(state, Promise.resolve(true));
    await expect(confirmed).resolves.toBe(true);
    expect(state.promise).toBe(confirmed);
    expect(state.retryEligible).toBe(false);

    const failed = runtimeStopAttemptState();
    await expect(trackRuntimeStopAttempt(failed, Promise.resolve(false)))
      .resolves.toBe(false);
    expect(failed).toMatchObject({ promise: null, retryEligible: true });
  });

  it("releases a rejected stop attempt without hiding its error", async () => {
    const state = runtimeStopAttemptState();
    const tracked = trackRuntimeStopAttempt(
      state,
      Promise.reject(new Error("shutdown rejected")),
    );
    await expect(tracked).rejects.toThrow("shutdown rejected");
    expect(state).toMatchObject({ promise: null, retryEligible: true });
  });
});
