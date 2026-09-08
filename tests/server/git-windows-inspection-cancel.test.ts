import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runtimeShutdownDeadlineMs } from "../../src/node/runtime-shutdown-deadline";

const spawning = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn: spawning.spawn,
}));
let runner: typeof import("../../src/server/git/runner");
function childFixture(): ChildProcess {
  const stdout = new PassThrough(), stderr = new PassThrough();
  return Object.assign(new EventEmitter(), {
    pid: 424242, exitCode: null, signalCode: null, stdin: null,
    stdout, stderr, stdio: [null, stdout, stderr], kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
}
function close(child: ChildProcess, code = 0): void {
  Object.assign(child, { exitCode: code });
  child.stdout?.destroy(); child.stderr?.destroy();
  child.emit("exit", code, null); child.emit("close", code, null);
}
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); spawning.spawn.mockReset();
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  runner = await import("../../src/server/git/runner");
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("lets a cancelled read-only child close after 250ms, rejects its late result and admits no follow-up", async () => {
  const child = childFixture(), taskkill = childFixture();
  spawning.spawn.mockReturnValueOnce(child).mockReturnValue(taskkill);
  const abort = new AbortController();
  let settled = false;
  const result = runner.runGitInspection("/synthetic", ["status"], {
    signal: abort.signal, failureMessage: "Inspection failed.",
  }).catch((error: unknown) => error).finally(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(0);
  abort.abort();
  await expect(runner.runGitInspection("/synthetic", ["status"], {
    signal: abort.signal, failureMessage: "Must not spawn.",
  })).rejects.toMatchObject({ code: "timeout" });
  await vi.advanceTimersByTimeAsync(600);
  expect(settled).toBe(false);
  expect(spawning.spawn).toHaveBeenCalledOnce();
  child.stdout!.emit("data", Buffer.from("late success")); close(child);
  await expect(result).resolves.toMatchObject({ code: "timeout", message: "Git inspection was cancelled." });
  expect(spawning.spawn).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["timeoutMs", "deadlineAt"] as const)("preserves the shorter %s and its 250ms hard-deadline drain", async (deadline) => {
  const child = childFixture(), taskkill = childFixture();
  spawning.spawn.mockReturnValueOnce(child).mockReturnValue(taskkill);
  const abort = new AbortController();
  const result = runner.runGitInspection("/synthetic", ["status"], {
    ...(deadline === "timeoutMs" ? { timeoutMs: 1_000 } : { deadlineAt: Date.now() + 1_000 }),
    signal: abort.signal, failureMessage: "Inspection failed.",
  }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0); abort.abort();
  await vi.advanceTimersByTimeAsync(1_249);
  expect(spawning.spawn).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(spawning.spawn).toHaveBeenCalledTimes(2);
  taskkill.emit("close", 0); close(child);
  await vi.advanceTimersByTimeAsync(100);
  await expect(result).resolves.toMatchObject({ code: "timeout", message: "Git inspection was cancelled." });
  expect(vi.getTimerCount()).toBe(0);
});

it("stops a hung cancelled inspection after 2s and retains failed tree proof after direct close", async () => {
  const child = childFixture(), taskkill = childFixture();
  spawning.spawn.mockReturnValueOnce(child).mockReturnValue(taskkill);
  const abort = new AbortController();
  let settled = false;
  const result = runner.runGitInspection("/synthetic", ["status"], {
    signal: abort.signal, failureMessage: "Inspection failed.",
  }).catch((error: unknown) => error).finally(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(0); abort.abort();
  await vi.advanceTimersByTimeAsync(1_999);
  expect(spawning.spawn).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(spawning.spawn).toHaveBeenCalledTimes(2);
  expect(settled).toBe(false);
  close(child); taskkill.emit("close", 128);
  await vi.advanceTimersByTimeAsync(100);
  await expect(result).resolves.toMatchObject({
    code: "operation-failed", message: "Git stopped responding, and its process tree could not be confirmed stopped.",
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds shutdown drain including actual Windows taskkill, child-close and resource settling", async () => {
  const child = childFixture(), taskkill = childFixture();
  spawning.spawn.mockReturnValueOnce(child).mockReturnValue(taskkill);
  let settled = false;
  const result = runner.runGitInspection("/synthetic", ["status"], {
    timeoutMs: 2_000, failureMessage: "Inspection failed.",
  }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  const { gitInspectionLifecycle } = await import("../../src/server/git/inspection-lifecycle");
  const shutdownStartedAt = Date.now();
  const drain = gitInspectionLifecycle.cancelAndDrainWhile(async () => {
    await expect(runner.runGitInspection("/synthetic", ["status"], {
      failureMessage: "Shutdown must not admit a child.",
    })).rejects.toMatchObject({ code: "timeout" });
  }).finally(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(2_249);
  expect(spawning.spawn).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(spawning.spawn).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1_999); taskkill.emit("close", 0);
  await vi.advanceTimersByTimeAsync(1_999); close(child);
  await vi.advanceTimersByTimeAsync(99); expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await drain;
  await expect(result).resolves.toMatchObject({ code: "timeout", message: "Git inspection was cancelled." });
  const shutdownElapsedMs = Date.now() - shutdownStartedAt;
  expect(shutdownElapsedMs).toBe(6_348);
  expect(shutdownElapsedMs).toBeLessThan(runtimeShutdownDeadlineMs("win32"));
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps mutating Git cancellation on the existing 250ms path", async () => {
  const child = childFixture(); spawning.spawn.mockReturnValue(child);
  const abort = new AbortController(), terminateProcessTree = vi.fn(async () => true);
  const result = runner.runGit("/synthetic", ["commit"], {
    signal: abort.signal, failureMessage: "Commit failed.",
  }, { terminateProcessTree }).catch((error: unknown) => error);
  abort.abort(); await vi.advanceTimersByTimeAsync(249);
  expect(terminateProcessTree).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toMatchObject({ code: "timeout" });
  expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith(child, true);
});

it("keeps a hard-timeout inspection final while it closes during the existing drain", async () => {
  const child = childFixture(); spawning.spawn.mockReturnValue(child);
  const result = runner.runGitInspection("/synthetic", ["status"], {
    timeoutMs: 100, failureMessage: "Inspection failed.",
  }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(150); close(child);
  await expect(result).resolves.toMatchObject({ code: "timeout", message: "Git took too long to complete the operation." });
  expect(spawning.spawn).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps POSIX read-only cancellation on the existing 250ms path", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const lifecycle = await import("../../src/server/process-lifecycle");
  const terminate = vi.spyOn(lifecycle, "terminateProcessTreeAndWait").mockResolvedValue(true);
  const child = childFixture(); spawning.spawn.mockReturnValue(child);
  const abort = new AbortController();
  const result = runner.runGitInspection("/synthetic", ["status"], {
    signal: abort.signal, failureMessage: "Inspection failed.",
  }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0); abort.abort();
  await vi.advanceTimersByTimeAsync(249); expect(terminate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toMatchObject({ code: "timeout" });
  expect(terminate).toHaveBeenCalledExactlyOnceWith(child, true);
});
