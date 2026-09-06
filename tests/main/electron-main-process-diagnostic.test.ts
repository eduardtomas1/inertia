import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import type { ElectronApplication } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createElectronMainProcessDiagnostic } from
  "../e2e/support/electron-main-process-diagnostic";
import { closeElectronFixtureBounded, ElectronFixtureCloseError } from
  "../e2e/support/electron-app-lifecycle";
import { attachElectronFixtureCloseFailure, closeElectronAfterTest } from
  "../e2e/support/electron-failure-evidence";

function child(pid: number): ChildProcess {
  const instance = Object.assign(new EventEmitter(), {
    pid, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn(),
    kill: vi.fn((signal: NodeJS.Signals) => {
      instance.signalCode = signal;
      instance.emit("exit", null, signal);
      return true;
    }),
  });
  return instance as unknown as ChildProcess;
}

function fixture() {
  const main = child(123456);
  const samplers: ChildProcess[] = [];
  const spawnSample = vi.fn(() => {
    const sampler = child(123457 + samplers.length);
    samplers.push(sampler);
    return sampler;
  });
  const killGroup = vi.fn();
  const diagnostic = createElectronMainProcessDiagnostic(main, {
    platform: "darwin", spawn: spawnSample as unknown as typeof spawn, killGroup,
  });
  return { main, samplers, spawnSample, killGroup, diagnostic };
}

afterEach(() => vi.useRealTimers());

describe("bounded macOS Electron main-process evidence", () => {
  it("samples only its retained numeric PID with a private process group and minimal environment", () => {
    vi.useFakeTimers();
    const f = fixture();
    f.diagnostic.capture("rpc-timeout", Date.now() + 5_000);
    expect(f.spawnSample).toHaveBeenCalledWith("/usr/bin/sample", [
      "123456", "1", "10", "-file", "/dev/stdout",
    ], {
      shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
    f.diagnostic.stop();
    expect(f.killGroup).toHaveBeenCalledWith(123457);
    expect(f.main.kill).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"] as const)("does not sample or arm a watchdog on %s", (platform) => {
    vi.useFakeTimers();
    const main = child(123456);
    const spawnSample = vi.fn();
    const diagnostic = createElectronMainProcessDiagnostic(main, { platform, spawn: spawnSample });
    diagnostic.capture("rpc-timeout", Date.now() + 5_000);
    diagnostic.watchQuit(Date.now() + 5_000);
    expect(spawnSample).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(main.listenerCount("exit")).toBe(0);
  });

  it("drains both streams continuously while retaining at most 128 KiB per sample", () => {
    vi.useFakeTimers();
    const f = fixture();
    f.diagnostic.capture("rpc-timeout", Date.now() + 5_000);
    const sampler = f.samplers[0]!;
    sampler.stdout!.emit("data", Buffer.from("main-thread-stack\n"));
    sampler.stderr!.emit("data", Buffer.alloc(256 * 1024, "x"));
    sampler.stdout!.emit("data", Buffer.alloc(256 * 1024, "y"));
    expect(sampler.stdout!.listenerCount("data")).toBe(1);
    expect(sampler.stderr!.listenerCount("data")).toBe(1);
    sampler.emit("close", 0, null);
    expect(f.diagnostic.samples[0]).toMatchObject({ status: "completed", truncated: true });
    expect(f.diagnostic.samples[0]!.output).toHaveLength(128 * 1024);
    expect(f.diagnostic.samples[0]!.output).toMatch(/^main-thread-stack\n/u);
    f.diagnostic.stop();
  });

  it("kills the sampler group at 2 s even when neither it nor its pipes settle", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.diagnostic.capture("rpc-timeout", Date.now() + 5_000);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(f.killGroup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.killGroup).toHaveBeenCalledExactlyOnceWith(123457);
    expect(f.samplers[0]!.stdout!.destroyed).toBe(true);
    expect(f.samplers[0]!.stderr!.destroyed).toBe(true);
    expect(f.samplers[0]!.unref).toHaveBeenCalledOnce();
    expect(f.diagnostic.samples[0]!.status).toBe("timed-out");
    f.diagnostic.stop();
  });

  it("cancels on the retained child exit and never samples a reused PID", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.diagnostic.capture("rpc-timeout", Date.now() + 5_000);
    f.main.emit("exit", 0, null);
    f.diagnostic.capture("later-phase", Date.now() + 5_000);
    f.diagnostic.watchQuit(Date.now() + 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.spawnSample).toHaveBeenCalledOnce();
    expect(f.killGroup).toHaveBeenCalledExactlyOnceWith(123457);
    expect(f.diagnostic.samples[0]!.status).toBe("cancelled-at-fixture-exit-or-kill-deadline");
    expect(f.main.listenerCount("exit")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses a changed child PID and a window too short for bounded evidence", () => {
    vi.useFakeTimers();
    const f = fixture();
    f.diagnostic.capture("short-window", Date.now() + 2_000);
    expect(f.diagnostic.samples[0]!.status).toBe("skipped-insufficient-existing-budget");
    Object.assign(f.main, { pid: 987654 });
    f.diagnostic.capture("different-pid", Date.now() + 5_000);
    expect(f.spawnSample).not.toHaveBeenCalled();
    f.diagnostic.stop();
  });

  it("reports an unavailable sampler without throwing or leaving its deadline active", () => {
    vi.useFakeTimers();
    const f = fixture();
    f.diagnostic.capture("rpc-timeout", Date.now() + 5_000);
    f.samplers[0]!.emit("error", new Error("spawn /usr/bin/sample ENOENT"));
    expect(f.diagnostic.samples[0]!.status).toContain("unavailable:");
    expect(vi.getTimerCount()).toBe(0);
    f.diagnostic.stop();
  });

  it("stays quiet for a fast quit and samples a stalled quit only after 1 s", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const stopWatchdog = f.diagnostic.watchQuit(Date.now() + 5_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.spawnSample).not.toHaveBeenCalled();
    stopWatchdog();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.spawnSample).not.toHaveBeenCalled();
    f.diagnostic.watchQuit(Date.now() + 5_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.diagnostic.samples[0]!.reason).toBe("prepared-quit-still-pending");
    f.diagnostic.stop();
  });

  it.each([false, true])("preserves the 5 s prepared-quit kill deadline with a stalled sampler (stop error: %s)", async (stopError) => {
    vi.useFakeTimers();
    const f = fixture();
    if (stopError) f.killGroup.mockImplementation(() => { throw new Error("sample kill failed"); });
    const closing = closeElectronFixtureBounded({
      platform: "darwin",
      current: { process: () => f.main, close: async () => undefined } as unknown as ElectronApplication,
      prepareRuntimeQuit: async () => ({
        phase: "privileged-cleanup-complete", runtimePid: null,
        cleanupConfirmed: true, errorMessage: null,
      }),
      requestRuntimeQuit: async () => null,
      waitForRuntimeExit: vi.fn(async () => undefined),
      closeServer: vi.fn(async () => undefined),
      removeDirectory: vi.fn(async () => undefined),
      rpcTimeoutMs: 5_000, createMainProcessDiagnostic: () => f.diagnostic,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.main.kill).not.toHaveBeenCalled();
    expect(f.spawnSample).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    const error = await closing;
    expect(f.main.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(error).toBeInstanceOf(ElectronFixtureCloseError);
    expect((error as ElectronFixtureCloseError).mainProcessSamples[0]!.status)
      .toContain(stopError ? "sampler-stop-failed" : "timed-out");
  });

  it("preserves snapshot, receipt and phase budgets and withholds exit without a receipt", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const requestRuntimeQuit = vi.fn(async () => null);
    const closing = closeElectronFixtureBounded({
      platform: "darwin",
      current: { process: () => f.main, close: async () => undefined } as unknown as ElectronApplication,
      readRuntimePid: () => new Promise(() => undefined),
      prepareRuntimeQuit: () => new Promise(() => undefined),
      readRuntimeQuitPhase: () => new Promise(() => undefined),
      requestRuntimeQuit, waitForRuntimeExit: vi.fn(async () => undefined),
      closeServer: vi.fn(async () => undefined), removeDirectory: vi.fn(async () => undefined),
      rpcTimeoutMs: 5_000, cleanupReceiptTimeoutMs: 17_750,
      createMainProcessDiagnostic: () => f.diagnostic,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.spawnSample).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.diagnostic.samples[0]!.reason).toBe("runtime-snapshot-timed-out");
    await vi.advanceTimersByTimeAsync(17_750);
    expect(f.diagnostic.samples[1]!.reason).toBe("privileged-cleanup-receipt-failed");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.main.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // The existing unconfirmed-receipt path uses a zero-delay exit wait,
    // which fake timers deliver on the next timer turn.
    await vi.advanceTimersByTimeAsync(1);
    expect(await closing).toBeInstanceOf(ElectronFixtureCloseError);
    expect(requestRuntimeQuit).not.toHaveBeenCalled();
    expect(f.main.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an active sample before the existing immediate forced-quit turn", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const events: string[] = [];
    f.killGroup.mockImplementation(() => { events.push("sampler-stopped"); });
    f.main.once("exit", () => events.push("main-exited"));
    f.diagnostic.capture("earlier-rpc-timeout", Date.now() + 5_000);
    const closing = closeElectronFixtureBounded({
      platform: "darwin",
      current: { process: () => f.main, close: async () => undefined } as unknown as ElectronApplication,
      prepareRuntimeQuit: async () => ({
        phase: "privileged-cleanup-complete", runtimePid: null,
        cleanupConfirmed: false, errorMessage: "Owner did not stop",
      }),
      requestRuntimeQuit: async () => null,
      waitForRuntimeExit: vi.fn(async () => undefined),
      closeServer: vi.fn(async () => undefined), removeDirectory: vi.fn(async () => undefined),
      createMainProcessDiagnostic: () => f.diagnostic,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1);
    expect(await closing).toBeInstanceOf(ElectronFixtureCloseError);
    expect(events).toEqual(["sampler-stopped", "main-exited"]);
    expect(f.diagnostic.samples[0]!.status).toBe("cancelled-at-fixture-exit-or-kill-deadline");
  });

  it("attaches sample evidence only for a close failure that has samples", async () => {
    const attach = vi.fn(async () => undefined);
    await attachElectronFixtureCloseFailure(() => ({ attach }), new Error("Different error"));
    await attachElectronFixtureCloseFailure(() => ({ attach }), new ElectronFixtureCloseError([], []));
    expect(attach).not.toHaveBeenCalled();
    const sample = { pid: 123456, reason: "rpc-timeout", status: "unavailable", output: "", truncated: false };
    await attachElectronFixtureCloseFailure(() => ({ attach }), new ElectronFixtureCloseError([], [sample]));
    expect(attach).toHaveBeenCalledWith("electron-main-process-samples", {
      contentType: "application/json", body: Buffer.from(JSON.stringify([sample], null, 2)),
    });
  });

  it.each(["fulfilled", "rejected", "hung", "context-unavailable"])("retains both body and cleanup errors when attachment is %s", async (attachmentStatus) => {
    vi.useFakeTimers();
    const bodyError = new Error("Original assertion failed");
    const cleanupError = new Error("Cleanup failed");
    const cleanup = vi.fn(async () => { throw cleanupError; });
    const attach = vi.fn(() => attachmentStatus === "hung"
      ? new Promise<void>(() => undefined)
      : attachmentStatus === "rejected" ? Promise.reject(new Error("report failed")) : Promise.resolve());
    const readTestInfo = () => {
      if (attachmentStatus === "context-unavailable") throw new Error("No test context");
      return { attach };
    };
    const failure = closeElectronAfterTest(cleanup, readTestInfo, { error: bodyError })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(cleanup).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(250);
    const error = await failure as AggregateError;
    expect(error.errors).toEqual([bodyError, cleanupError]);
    expect(error.cause).toBe(bodyError);
    if (attachmentStatus !== "context-unavailable") {
      expect(attach).toHaveBeenCalledWith("original-test-body-failure", {
        body: Buffer.from(bodyError.stack!), contentType: "text/plain",
      });
    }
  });
});
