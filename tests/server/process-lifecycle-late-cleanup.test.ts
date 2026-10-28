// @inertia-test-suite portable
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const ownership = vi.hoisted(() => ({ released: false }));

vi.mock("../../src/node/runtime-owned-processes", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/node/runtime-owned-processes")>();
  return {
    ...original,
    requestRuntimeOwnedGuardianStop: () => Promise.resolve(true),
    confirmRuntimeOwnedProcessStopped: () => ownership.released,
    runtimeOwnedProcessStopConfirmation: () => ownership.released,
    awaitRuntimeOwnedProcessStopped: () => new Promise<boolean>(() => undefined),
  };
});

import {
  createOwnedProcessTreeTermination,
  forceTerminationBudgetMs,
  lateCleanupConfirmation,
  terminateProcessTreeAndWait,
} from "../../src/server/process-lifecycle";

function guardianChild(closeAfterMs: number | null, release = true): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid: 4_242,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdio: [null, null, null],
  });
  if (closeAfterMs !== null) {
    setTimeout(() => {
      child.exitCode = 143;
      ownership.released = release;
      child.emit("close", 143, null);
    }, closeAfterMs);
  }
  return child as unknown as ChildProcess;
}

const linuxTerminator = (child: ChildProcess, force: boolean) =>
  terminateProcessTreeAndWait(child, force, { platform: "linux" });

function outcome(attempt: Promise<void>): Promise<string> {
  return attempt.then(() => "confirmed", (error: Error) => error.message);
}

afterEach(() => {
  vi.useRealTimers();
  ownership.released = false;
});

describe("late provider cleanup confirmation", () => {
  it("gives Linux, macOS and other platforms their own force termination budgets", () => {
    expect(forceTerminationBudgetMs("linux")).toBe(10_000);
    expect(forceTerminationBudgetMs("darwin")).toBe(5_000);
    expect(forceTerminationBudgetMs("win32")).toBe(2_000);
  });

  it.each([2_100, 6_000])(
    "confirms a Linux guardian that drains and is released after %i ms",
    async (closeAfterMs) => {
      vi.useFakeTimers();
      const child = guardianChild(closeAfterMs);
      const terminate = createOwnedProcessTreeTermination(child, "Claude Code", linuxTerminator);
      const first = outcome(terminate(true));
      await vi.advanceTimersByTimeAsync(closeAfterMs + 1_000);
      expect(await first).toBe("confirmed");
    },
  );

  it("bounds a Linux guardian's close and ownership proof by one force termination budget", async () => {
    vi.useFakeTimers();
    const child = guardianChild(9_000, false);
    let settled: boolean | null = null;
    void terminateProcessTreeAndWait(child, true, { platform: "linux" }).then((value) => {
      settled = value;
    });
    await vi.advanceTimersByTimeAsync(9_500);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(forceTerminationBudgetMs("linux") - 9_500);
    expect(settled).toBe(false);
  });

  it("resolves the next request once a guardian that missed the budget closes and is released", async () => {
    vi.useFakeTimers();
    const child = guardianChild(25_000);
    const terminate = createOwnedProcessTreeTermination(child, "Claude Code", linuxTerminator);
    const first = outcome(terminate(true));
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await first).toBe("Claude Code could not be confirmed stopped.");

    const beforeClose = outcome(terminate(true));
    await vi.advanceTimersByTimeAsync(forceTerminationBudgetMs(process.platform) + 1_000);
    expect(await beforeClose).toBe("Claude Code could not be confirmed stopped.");

    await vi.advanceTimersByTimeAsync(14_000);
    expect(ownership.released).toBe(true);
    const afterClose = outcome(terminate(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(await afterClose).toBe("confirmed");
    expect(await outcome(terminate(true))).toBe("confirmed");
  });

  it("resolves a late confirmation false at its budget without rejecting", async () => {
    vi.useFakeTimers();
    const child = guardianChild(null);
    let settled: boolean | null = null;
    void lateCleanupConfirmation(child, 3_000).then((value) => {
      settled = value;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
  });

  it("resolves a late confirmation false when ownership retirement never finishes", async () => {
    vi.useFakeTimers();
    const child = guardianChild(100, false);
    const confirmation = lateCleanupConfirmation(child, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(confirmation).resolves.toBe(false);
  });

  it("confirms late once the exact runtime claim is released after close", async () => {
    vi.useFakeTimers();
    const child = guardianChild(500);
    const confirmation = lateCleanupConfirmation(child, 1_000);
    await vi.advanceTimersByTimeAsync(500);
    await expect(confirmation).resolves.toBe(true);
  });
});
