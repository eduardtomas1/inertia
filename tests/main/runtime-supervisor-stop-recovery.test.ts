// @inertia-test-suite portable

import { describe, expect, it } from "vitest";

import {
  runtimeStopAttemptState,
  trackRuntimeStopAttempt,
} from "../../src/main/runtime-supervisor-stop-recovery";

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
