import { describe, expect, it, vi } from "vitest";

import {
  createRendererCrashRecovery,
  RENDERER_RECOVERY_INTERVAL_MS,
} from "../../src/main/renderer-crash-recovery";

function recovery(canReload = () => true) {
  let now = 1_000;
  const reload = vi.fn();
  const recover = createRendererCrashRecovery({ reload, canReload, now: () => now });
  return { recover, reload, advance: (milliseconds: number) => { now += milliseconds; } };
}

describe("main window renderer crash recovery", () => {
  it.each(["crashed", "oom", "killed", "abnormal-exit"])("reloads the window once after the renderer is gone (%s)", (reason) => {
    const { recover, reload } = recovery();

    expect(recover({ reason })).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("leaves a clean renderer exit alone", () => {
    const { recover, reload } = recovery();

    expect(recover({ reason: "clean-exit" })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload while the app is shutting down or the window is gone", () => {
    const { recover, reload } = recovery(() => false);

    expect(recover({ reason: "crashed" })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("stops after one reload when the reloaded renderer crashes again soon", () => {
    const { recover, reload, advance } = recovery();

    recover({ reason: "crashed" });
    advance(RENDERER_RECOVERY_INTERVAL_MS - 1);
    expect(recover({ reason: "crashed" })).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("recovers again from a later unrelated crash", () => {
    const { recover, reload, advance } = recovery();

    recover({ reason: "crashed" });
    advance(RENDERER_RECOVERY_INTERVAL_MS);
    expect(recover({ reason: "oom" })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
