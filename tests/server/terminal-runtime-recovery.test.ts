import { describe, expect, it, vi } from "vitest";

import { requestRecoveryFromTaintedOwnedProcess } from "../../src/server/terminal-runtime-recovery";

describe("terminal runtime recovery", () => {
  it("requests recovery after terminal spawn observes tainted ownership", () => {
    const recover = vi.fn();

    requestRecoveryFromTaintedOwnedProcess(recover, () => true);

    expect(recover).toHaveBeenCalledOnce();
  });

  it("does not restart the runtime for an ordinary terminal spawn failure", () => {
    const recover = vi.fn();

    requestRecoveryFromTaintedOwnedProcess(recover, () => false);

    expect(recover).not.toHaveBeenCalled();
  });

  it("keeps tainted ownership fail closed when the recovery signal throws", () => {
    expect(() => requestRecoveryFromTaintedOwnedProcess(
      () => { throw new Error("restart unavailable"); },
      () => true,
    )).not.toThrow();
  });
});
