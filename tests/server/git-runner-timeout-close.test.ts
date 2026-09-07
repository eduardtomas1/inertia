import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawning = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: spawning.spawn,
}));

import { runGit } from "../../src/server/git/runner";

function processFixture(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: 424242,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  return child;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("Git timeout cleanup settlement", () => {
  it.each(["abort-first", "timeout-first"])(
    "keeps one cleanup window and the first cancellation reason for %s",
    async (order) => {
      const child = processFixture();
      spawning.spawn.mockReturnValue(child);
      const abort = new AbortController();
      const terminateProcessTree = vi.fn(async () => true);
      const result = runGit("/synthetic", ["status"], {
        timeoutMs: 100,
        signal: abort.signal,
        failureMessage: "Git status failed.",
      }, { terminateProcessTree }).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(order === "abort-first" ? 90 : 110);
      abort.abort();
      await vi.advanceTimersByTimeAsync(order === "abort-first" ? 249 : 239);
      expect(terminateProcessTree).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toMatchObject({
        code: "timeout",
        message: order === "abort-first"
          ? "Git inspection was cancelled."
          : "Git took too long to complete the operation.",
      });
      expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith(child, true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("retains the timeout while an already-finishing process closes without another stop", async () => {
    const child = processFixture();
    spawning.spawn.mockReturnValue(child);
    const terminateProcessTree = vi.fn(async () => true);
    const result = runGit("/synthetic", ["status"], {
      timeoutMs: 100,
      failureMessage: "Git status failed.",
    }, { terminateProcessTree }).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(100);
    expect(terminateProcessTree).not.toHaveBeenCalled();
    child.stdout!.emit("data", Buffer.from("late result"));
    await vi.advanceTimersByTimeAsync(50);
    child.emit("close", 0, null);

    await expect(result).resolves.toMatchObject({
      code: "timeout",
      message: "Git took too long to complete the operation.",
    });
    expect(terminateProcessTree).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops a non-closing process at the existing drain bound and awaits cleanup proof", async () => {
    const child = processFixture();
    spawning.spawn.mockReturnValue(child);
    let finishCleanup!: (confirmed: boolean) => void;
    const terminateProcessTree = vi.fn(() => new Promise<boolean>((resolve) => {
      finishCleanup = resolve;
    }));
    let settled = false;
    const result = runGit("/synthetic", ["status"], {
      timeoutMs: 100,
      failureMessage: "Git status failed.",
    }, { terminateProcessTree }).catch((error: unknown) => error)
      .finally(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(349);
    expect(terminateProcessTree).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith(child, true);
    child.emit("close", 0, null);
    await Promise.resolve();
    expect(settled).toBe(false);
    finishCleanup(false);
    await expect(result).resolves.toMatchObject({
      code: "operation-failed",
      message: "Git stopped responding, and its process tree could not be confirmed stopped.",
    });
  });
});
