import { describe, expect, it, vi } from "vitest";

import {
  createRendererCrashRecovery,
  RENDERER_RECOVERY_INTERVAL_MS,
} from "../../src/main/renderer-crash-recovery";

function recovery(canReload = () => true) {
  let now = 1_000;
  const reload = vi.fn();
  const timers: Array<{ at: number; callback: () => void }> = [];
  const recover = createRendererCrashRecovery({
    reload, canReload, now: () => now,
    setTimer: (callback, milliseconds) => { timers.push({ at: now + milliseconds, callback }); },
  });
  return {
    recover, reload, timers,
    advance: (milliseconds: number) => {
      now += milliseconds;
      for (const timer of timers.filter(({ at }) => at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.callback();
      }
    },
  };
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

  it("defers the next reload to the end of the interval when the reloaded renderer crashes again soon", () => {
    const { recover, reload, advance, timers } = recovery();

    recover({ reason: "crashed" });
    advance(RENDERER_RECOVERY_INTERVAL_MS - 10);
    expect(recover({ reason: "crashed" })).toBe(true);
    expect(recover({ reason: "crashed" })).toBe(true);
    expect(timers).toHaveLength(1);
    expect(reload).toHaveBeenCalledOnce();
    advance(9);
    expect(reload).toHaveBeenCalledOnce();
    advance(1);
    expect(reload).toHaveBeenCalledTimes(2);

    expect(recover({ reason: "crashed" })).toBe(true);
    advance(RENDERER_RECOVERY_INTERVAL_MS);
    expect(reload).toHaveBeenCalledTimes(3);
  });

  it("drops a deferred reload once the window can no longer reload", () => {
    let canReload = true;
    const { recover, reload, advance } = recovery(() => canReload);

    recover({ reason: "crashed" });
    expect(recover({ reason: "crashed" })).toBe(true);
    canReload = false;
    advance(RENDERER_RECOVERY_INTERVAL_MS);
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
