import { afterEach, describe, expect, it, vi } from "vitest";

import { captureBoundedFailureDiagnostic } from "./bounded-failure-diagnostic";

describe("bounded failure diagnostics", () => {
  afterEach(() => vi.useRealTimers());

  it("captures a diagnostic that settles inside its deadline", async () => {
    await expect(captureBoundedFailureDiagnostic(
      async () => ({ terminalIds: ["terminal-1"] }),
      100,
    )).resolves.toEqual({
      outcome: "captured",
      value: { terminalIds: ["terminal-1"] },
    });
  });

  it("reports capture failures without replacing the original failure", async () => {
    await expect(captureBoundedFailureDiagnostic(
      async () => { throw new Error("renderer unavailable"); },
      100,
    )).resolves.toEqual({ outcome: "failed" });
  });

  it("settles when a renderer diagnostic never responds", async () => {
    vi.useFakeTimers();
    const result = captureBoundedFailureDiagnostic(
      async () => await new Promise<never>(() => undefined),
      100,
    );

    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toEqual({ outcome: "timed-out" });
  });
});
