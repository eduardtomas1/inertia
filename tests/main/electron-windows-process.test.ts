import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import type { ElectronApplication } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeElectronAppBounded, closeElectronFixtureBounded,
  ElectronFixtureCloseError, quitElectronAppBounded } from "../e2e/support/electron-app-lifecycle";
import { forceStopWindowsElectronLauncher } from "../e2e/support/electron-windows-process";

function windowsLauncher() {
  const pipe = { closed: false };
  let descendantAlive = true;
  const child = Object.assign(new EventEmitter(), {
    pid: 424242, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdio: [null, pipe, pipe],
    kill: vi.fn((signal: NodeJS.Signals) => {
      child.signalCode = signal;
      child.emit("exit", null, signal);
      // Terminating cmd.exe alone does not terminate the Electron descendant
      // or close the pipe it inherited from the retained launcher.
      return true;
    }),
  });
  const taskkill = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
  const spawnProcess = vi.fn(() => taskkill);
  let finishProtocol!: () => void;
  const protocol = new Promise<void>((resolve) => { finishProtocol = resolve; });
  const close = vi.fn(() => protocol);
  const stopTree = (): void => {
    descendantAlive = false;
    child.exitCode = 1;
    child.emit("exit", 1, null);
  };
  const closePipes = (): void => {
    pipe.closed = true;
    child.emit("close", child.exitCode, child.signalCode);
    finishProtocol();
  };
  return {
    child: child as unknown as ChildProcess, taskkill, spawnProcess, close, stopTree, closePipes,
    get descendantAlive() { return descendantAlive; },
    get pipeClosed() { return pipe.closed; },
    app: { process: () => child, close } as unknown as ElectronApplication,
    dependencies: { spawnProcess: spawnProcess as unknown as typeof spawn, windowsSystemRoot: "C:\\Windows" },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("owned Windows Electron launcher cleanup", () => {
  it("demonstrates that the old direct-child fallback leaves a descendant and inherited pipes", async () => {
    const f = windowsLauncher();
    // The POSIX branch retains the former direct-child implementation, used
    // here as a deterministic control for the Windows launcher model.
    const quitting = quitElectronAppBounded(f.app, async () => undefined, {
      platform: "linux", gracefulTimeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(quitting).resolves.toMatchObject({ outcome: "forced", transportSettled: false });
    expect(f.child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(f.descendantAlive).toBe(true);
    expect(f.pipeClosed).toBe(false);
    f.stopTree(); f.closePipes();
  });

  it("targets only the live retained launcher's tree and awaits descendant pipe closure", async () => {
    const f = windowsLauncher();
    let settled = false;
    const stopping = forceStopWindowsElectronLauncher(f.child, 5_000, f.dependencies)
      .then((result) => { settled = true; return result; });
    expect(f.spawnProcess).toHaveBeenCalledExactlyOnceWith(
      "C:\\Windows\\System32\\taskkill.exe", ["/pid", "424242", "/t", "/f"],
      { shell: false, windowsHide: true, stdio: "ignore" },
    );
    f.stopTree();
    f.taskkill.emit("close", 0);
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(false);
    expect(f.pipeClosed).toBe(false);
    f.closePipes();
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(stopping).resolves.toBe(true);
    expect(f.descendantAlive).toBe(false);
    expect(f.child.kill).not.toHaveBeenCalled();
    expect(f.child.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares one five-second deadline across taskkill, close and resource settling", async () => {
    const f = windowsLauncher();
    const stopping = forceStopWindowsElectronLauncher(f.child, 5_000, f.dependencies);
    await vi.advanceTimersByTimeAsync(4_700);
    f.stopTree(); f.taskkill.emit("close", 0);
    await vi.advanceTimersByTimeAsync(150);
    f.closePipes();
    await vi.advanceTimersByTimeAsync(100);
    await expect(stopping).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not add a fresh close budget after a slow taskkill", async () => {
    const f = windowsLauncher();
    const stopping = forceStopWindowsElectronLauncher(f.child, 5_000, f.dependencies);
    await vi.advanceTimersByTimeAsync(4_700);
    f.stopTree(); f.taskkill.emit("close", 0);
    await vi.advanceTimersByTimeAsync(200);
    await expect(stopping).resolves.toBe(false);
    expect(f.pipeClosed).toBe(false);
    expect(f.child.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a hung taskkill and never falls back to claiming root-only cleanup", async () => {
    const f = windowsLauncher();
    const stopping = forceStopWindowsElectronLauncher(f.child, 5_000, f.dependencies);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(stopping).resolves.toBe(false);
    expect(f.taskkill.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(f.child.kill).not.toHaveBeenCalled();
    expect(f.descendantAlive).toBe(true);
    expect(f.child.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["spawn-throw", "spawn-error", "nonzero"])("keeps %s tree cleanup unconfirmed", async (failure) => {
    const f = windowsLauncher();
    if (failure === "spawn-throw") f.spawnProcess.mockImplementation(() => { throw new Error("private spawn details"); });
    const stopping = forceStopWindowsElectronLauncher(f.child, 5_000, f.dependencies);
    if (failure === "spawn-error") f.taskkill.emit("error", new Error("private child details"));
    if (failure === "nonzero") f.taskkill.emit("close", 1);
    await expect(stopping).resolves.toBe(false);
    expect(f.child.kill).not.toHaveBeenCalled();
    expect(f.child.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, 0, 1, process.pid, Number.NaN])("does not signal an invalid or self root %s", async (pid) => {
    const f = windowsLauncher(); Object.assign(f.child, { pid });
    await expect(forceStopWindowsElectronLauncher(f.child, 5_000, f.dependencies)).resolves.toBe(false);
    expect(f.spawnProcess).not.toHaveBeenCalled();
  });

  it("does not retarget an exited launcher PID while descendant pipes remain open", async () => {
    const f = windowsLauncher(); Object.assign(f.child, { exitCode: 0 });
    await expect(forceStopWindowsElectronLauncher(f.child, 5_000, f.dependencies)).resolves.toBe(false);
    expect(f.spawnProcess).not.toHaveBeenCalled();
    expect(f.pipeClosed).toBe(false);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("refuses an invalid force budget %s", async (timeoutMs) => {
    const f = windowsLauncher();
    await expect(forceStopWindowsElectronLauncher(f.child, timeoutMs, f.dependencies)).resolves.toBe(false);
    expect(f.spawnProcess).not.toHaveBeenCalled();
  });

  it("retains forced status and waits for pipe closure before settling Playwright", async () => {
    const f = windowsLauncher();
    const quitting = quitElectronAppBounded(f.app, async () => undefined, {
      platform: "win32", windowsProcessDependencies: f.dependencies, gracefulTimeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    f.stopTree(); f.taskkill.emit("close", 0);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.close).not.toHaveBeenCalled();
    f.closePipes();
    await vi.advanceTimersByTimeAsync(100);
    await expect(quitting).resolves.toMatchObject({ outcome: "forced", transportSettled: true });
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.child.kill).not.toHaveBeenCalled();
  });

  it("uses tree cleanup in the fallback application-close path too", async () => {
    const f = windowsLauncher();
    const closing = closeElectronAppBounded(f.app, {
      platform: "win32", windowsProcessDependencies: f.dependencies, gracefulTimeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.spawnProcess).toHaveBeenCalledOnce();
    f.stopTree(); f.closePipes(); f.taskkill.emit("close", 0);
    await vi.advanceTimersByTimeAsync(100);
    await expect(closing).resolves.toBeUndefined();
    expect(f.child.kill).not.toHaveBeenCalled();
  });

  it.each([true, false])("keeps forced cleanup and directory failures visible (tree confirmed: %s)", async (confirmed) => {
    const f = windowsLauncher();
    const removalError = new Error("Profile removal failed");
    const closing = closeElectronFixtureBounded({
      current: f.app, platform: "win32", windowsProcessDependencies: f.dependencies,
      prepareRuntimeQuit: async () => ({ phase: "privileged-cleanup-complete",
        cleanupConfirmed: true, runtimePid: null, errorMessage: null }),
      requestRuntimeQuit: async () => null,
      waitForRuntimeExit: async () => undefined, closeServer: async () => undefined,
      removeDirectory: async () => { throw removalError; }, rpcTimeoutMs: 5_000,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    if (confirmed) { f.stopTree(); f.closePipes(); }
    f.taskkill.emit("close", confirmed ? 0 : 1);
    await vi.advanceTimersByTimeAsync(100);
    const error = await closing;
    expect(error).toBeInstanceOf(ElectronFixtureCloseError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: confirmed
        ? "The Electron fixture process required forced termination during close (phase=privileged-cleanup-complete)."
        : "The Electron fixture process tree did not close after forced quit." }), removalError,
    ]);
    expect((error as ElectronFixtureCloseError).processEvidence?.stages.map(({ stage }) => stage))
      .toContain(confirmed ? "force-stop-confirmed" : "force-stop-unconfirmed");
    expect((error as ElectronFixtureCloseError).processEvidence?.stages.at(-1)?.stage)
      .toBe("directory-remove-rejected");
    expect(f.close).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
