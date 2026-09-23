import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnchorInputDiagnostic } from "../e2e/support/anchor-input-diagnostic";

afterEach(() => vi.useRealTimers());

describe("bounded anchor input reporting", () => {
  it("retains the pre-fill result while a post-fill read is pending without awaiting it", async () => {
    const evaluate = vi.fn(async ({ action }: { action: string }) => {
      if (action === "read") return await new Promise<never>(() => undefined);
      return action === "heartbeat" ? "frame" : { valueLength: 0 };
    });
    vi.useFakeTimers();
    const diagnostic = createAnchorInputDiagnostic(evaluate, "fixture");
    await diagnostic.install();
    expect(diagnostic.afterFill()).toBeUndefined();
    const attach = vi.fn(async () => undefined);
    const report = diagnostic.attach({ attach });
    await vi.advanceTimersByTimeAsync(500);
    await report;
    expect(attach).toHaveBeenCalledWith("anchor-input-diagnostic", {
      contentType: "application/json",
      body: JSON.stringify({
        before: { outcome: "captured", value: { valueLength: 0 } },
        postFill: { outcome: "timed-out" }, failure: { outcome: "timed-out" },
        heartbeat: { outcome: "captured", value: "frame" },
      }),
    });
  });

  it.each(["reject", "hang"])("preserves the body failure and cleanup when evaluators/reporters %s", async (mode) => {
    vi.useFakeTimers();
    const unavailable = async (): Promise<never> => {
      if (mode === "reject") throw new Error("private failure detail");
      return await new Promise<never>(() => undefined);
    };
    const diagnostic = createAnchorInputDiagnostic(unavailable, "fixture");
    const original = new Error("original click failure");
    const close = vi.fn();
    const execution = (async () => {
      await diagnostic.install();
      diagnostic.afterFill();
      try { throw original; }
      catch (error) {
        await diagnostic.attach({ attach: unavailable });
        throw error;
      } finally {
        diagnostic.dispose();
        close();
      }
    })();
    const preserved = expect(execution).rejects.toBe(original);
    await vi.advanceTimersByTimeAsync(1_250);
    await preserved;
    expect(close).toHaveBeenCalledOnce();
    await vi.runOnlyPendingTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
  });
});
