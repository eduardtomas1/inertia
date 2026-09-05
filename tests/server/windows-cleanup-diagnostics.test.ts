// @inertia-test-suite portable
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOwnedPidProcessTreeTermination, terminateProcessTreeAndWait } from
  "../../src/server/process-lifecycle";
import { recordWindowsCleanupFailure, windowsCleanupFailures } from
  "../../src/server/windows-cleanup-diagnostics";

function child() {
  return Object.assign(new EventEmitter(), {
    pid: 4242, exitCode: null, signalCode: null, stdio: [], kill: vi.fn(() => true),
  });
}

describe("bounded Windows cleanup first-cause evidence", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps only eight validated records and returns detached copies", () => {
    for (let exitCode = 0; exitCode < 20; exitCode++) recordWindowsCleanupFailure({
      phase: "taskkill-exit", scope: "child", force: true, elapsedMs: 1, exitCode,
    });
    const captured = windowsCleanupFailures();
    expect(captured.map(({ exitCode }) => exitCode)).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
    captured[0]!.exitCode = 999;
    recordWindowsCleanupFailure({ ...captured[0]!, message: "secret" } as never);
    recordWindowsCleanupFailure({ ...captured[0]!, elapsedMs: Infinity });
    expect(windowsCleanupFailures()[0]!.exitCode).toBe(12);
  });

  it.each(["spawn", "error", "exit", "timeout"] as const)(
    "records taskkill %s without treating direct-child exit as tree proof",
    async (failure) => {
      vi.useFakeTimers();
      const process = child();
      const taskkill = child();
      const spawnProcess = vi.fn(() => {
        if (failure === "spawn") throw new Error("private path and environment");
        return taskkill;
      });
      const termination = terminateProcessTreeAndWait(process as never, true, {
        platform: "win32", spawnProcess: spawnProcess as never, waitMs: 200,
      });
      if (failure === "error") taskkill.emit("error", new Error("private output"));
      if (failure === "exit") taskkill.emit("close", 128);
      if (failure === "timeout") await vi.advanceTimersByTimeAsync(200);
      process.emit("close", 0);
      await vi.runAllTimersAsync();
      await expect(termination).resolves.toBe(false);
      expect(windowsCleanupFailures().at(-1)).toMatchObject({
        phase: `taskkill-${failure}`, scope: "child", force: true,
        exitCode: failure === "exit" ? 128 : null,
      });
      expect(JSON.stringify(windowsCleanupFailures())).not.toContain("private");
    },
  );

  it("distinguishes a child close timeout after successful taskkill", async () => {
    vi.useFakeTimers();
    const taskkill = child();
    const termination = terminateProcessTreeAndWait(child() as never, true, {
      platform: "win32", spawnProcess: vi.fn(() => taskkill) as never, waitMs: 200,
    });
    taskkill.emit("close", 0);
    await vi.runAllTimersAsync();
    await expect(termination).resolves.toBe(false);
    expect(windowsCleanupFailures().at(-1)).toMatchObject({ phase: "root-close", scope: "child" });
  });

  it("keeps PID root-close proof separate and never repeats taskkill", async () => {
    const taskkill = child();
    const spawnProcess = vi.fn(() => taskkill);
    const terminate = createOwnedPidProcessTreeTermination(4242, async () => false, {
      platform: "win32", spawnProcess: spawnProcess as never, waitMs: 500,
    });
    const termination = terminate();
    taskkill.emit("close", 0);
    await expect(termination).resolves.toBe(false);
    await expect(terminate()).resolves.toBe(false);
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(windowsCleanupFailures().at(-1)).toMatchObject({ phase: "root-close", scope: "pid" });
  });

  it("does not record successful cleanup as a failure", async () => {
    vi.useFakeTimers();
    const before = windowsCleanupFailures();
    const process = child();
    const taskkill = child();
    const termination = terminateProcessTreeAndWait(process as never, true, {
      platform: "win32", spawnProcess: vi.fn(() => taskkill) as never, waitMs: 200,
    });
    process.emit("close", 0);
    taskkill.emit("close", 0);
    await vi.runAllTimersAsync();
    await expect(termination).resolves.toBe(true);
    expect(windowsCleanupFailures()).toEqual(before);
  });
});
