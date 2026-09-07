import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeDiagnostics } from "../../src/main/runtime-diagnostics";
import { closeElectronFixtureBounded, ElectronFixtureCloseError } from
  "../e2e/support/electron-app-lifecycle";
import { attachElectronFixtureRuntimeRecords } from "../e2e/support/electron-failure-evidence";

const directories: string[] = [];

const idleFixture = {
  current: null,
  requestRuntimeQuit: async () => null,
  waitForRuntimeExit: async () => undefined,
};

describe("Electron cleanup failure evidence before fixture deletion", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })));
  });

  it("captures only after cleanup has failed and before removing its evidence directory", async () => {
    const order: string[] = [];
    const cleanupFailure = new Error("Synthetic server cleanup failure");
    let observedSignal: AbortSignal | undefined;
    const failure = await closeElectronFixtureBounded({
      ...idleFixture,
      closeServer: async () => { order.push("server"); throw cleanupFailure; },
      onCleanupFailure: async (signal) => {
        observedSignal = signal;
        order.push("evidence");
      },
      removeDirectory: async () => { order.push("remove"); },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ElectronFixtureCloseError);
    expect((failure as ElectronFixtureCloseError).errors).toEqual([cleanupFailure]);
    expect(order).toEqual(["server", "evidence", "remove"]);
    expect(observedSignal?.aborted).toBe(true);
  });

  it("does not read or report evidence during successful cleanup", async () => {
    const report = vi.fn(async () => undefined);
    const removeDirectory = vi.fn(async () => undefined);
    await closeElectronFixtureBounded({
      ...idleFixture,
      closeServer: async () => undefined,
      onCleanupFailure: report,
      removeDirectory,
    });
    expect(report).not.toHaveBeenCalled();
    expect(removeDirectory).toHaveBeenCalledOnce();
  });

  it.each(["throws", "rejects", "hangs"] as const)("preserves the cleanup error and removes data when reporting %s", async (outcome) => {
    vi.useFakeTimers();
    const cleanupFailure = new Error("Original cleanup failure");
    const reportingFailure = new Error("Private reporter failure must not replace cleanup");
    let observedSignal: AbortSignal | undefined;
    let rejectLate!: (reason: Error) => void;
    const report = vi.fn((signal: AbortSignal): Promise<void> => {
      observedSignal = signal;
      if (outcome === "throws") throw reportingFailure;
      if (outcome === "rejects") return Promise.reject(reportingFailure);
      return new Promise((_resolve, reject) => { rejectLate = reject; });
    });
    const removeDirectory = vi.fn(async () => undefined);
    const closing = closeElectronFixtureBounded({
      ...idleFixture,
      closeServer: async () => { throw cleanupFailure; },
      onCleanupFailure: report,
      removeDirectory,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledOnce();
    if (outcome === "hangs") {
      await vi.advanceTimersByTimeAsync(999);
      expect(removeDirectory).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
    }
    const failure = await closing as ElectronFixtureCloseError;
    expect(failure.errors).toEqual([cleanupFailure]);
    expect(removeDirectory).toHaveBeenCalledOnce();
    expect(observedSignal?.aborted).toBe(true);
    if (outcome === "hangs") {
      rejectLate(reportingFailure);
      await Promise.resolve();
      expect(failure.errors).toEqual([cleanupFailure]);
      expect(removeDirectory).toHaveBeenCalledOnce();
    }
  });

  it("still includes directory-removal failure after reporting the original cleanup failure", async () => {
    const cleanupFailure = new Error("Original cleanup failure");
    const removeFailure = new Error("Synthetic removal failure");
    const report = vi.fn(async () => undefined);
    const failure = await closeElectronFixtureBounded({
      ...idleFixture,
      closeServer: async () => { throw cleanupFailure; },
      onCleanupFailure: report,
      removeDirectory: async () => { throw removeFailure; },
    }).catch((error: unknown) => error) as ElectronFixtureCloseError;
    expect(failure.errors).toEqual([cleanupFailure, removeFailure]);
    expect(report).toHaveBeenCalledOnce();
  });

  it("retains only sanitized verified runtime records before the real private directory is removed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-cleanup-evidence-"));
    directories.push(directory);
    const logs = join(directory, "electron-profile", "logs", "runtime");
    const diagnostics = new RuntimeDiagnostics(logs);
    diagnostics.ensureDirectory();
    diagnostics.record("runtime.failure", {
      phase: "stopped", generation: 1,
      message: "Runtime shutdown could not confirm owned-process cleanup.",
    });
    diagnostics.record("runtime.failure", {
      phase: "stopped", generation: 1,
      message: "PRIVATE_PROMPT ws://127.0.0.1/PRIVATE_TOKEN",
    });
    const attach = vi.fn(async (_name: string, _options: { body?: Buffer | string }) => undefined);
    const cleanupFailure = new Error("Original cleanup failure");
    const failure = await closeElectronFixtureBounded({
      ...idleFixture,
      closeServer: async () => { throw cleanupFailure; },
      onCleanupFailure: async (signal) =>
        attachElectronFixtureRuntimeRecords(() => ({ attach }), directory, signal),
      removeDirectory: async () => rm(directory, { recursive: true, force: true }),
    }).catch((error: unknown) => error) as ElectronFixtureCloseError;

    expect(failure.errors).toEqual([cleanupFailure]);
    expect(attach).toHaveBeenCalledOnce();
    expect(attach.mock.calls[0]?.[0]).toBe("electron-cleanup-runtime-records");
    const body = String(attach.mock.calls[0]?.[1].body);
    expect(JSON.parse(body)).toMatchObject({ outcome: "captured", value: [
      { generation: 1, lastErrorCode: "owned-process-cleanup-unconfirmed" },
      { generation: 1, lastErrorCode: "detail-omitted" },
    ] });
    expect(body).not.toMatch(/PRIVATE|ws:\/\/|message|recordDigest/u);
    expect(body).not.toContain(directory);
    await expect(readFile(join(logs, "runtime.log"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records unavailable evidence without exposing filesystem failure details", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-cleanup-no-logs-"));
    directories.push(directory);
    const attach = vi.fn(async (_name: string, _options: { body?: Buffer | string }) => undefined);
    await attachElectronFixtureRuntimeRecords(() => ({ attach }), directory, new AbortController().signal);
    expect(attach).toHaveBeenCalledExactlyOnceWith("electron-cleanup-runtime-records", {
      body: Buffer.from(JSON.stringify({ outcome: "failed" }, null, 2)),
      contentType: "application/json",
    });
  });

  it("does not start record reads or reporting after capture was cancelled", async () => {
    const attach = vi.fn(async () => undefined);
    await attachElectronFixtureRuntimeRecords(() => ({ attach }), "unused-private-path", AbortSignal.abort());
    expect(attach).not.toHaveBeenCalled();
  });
});
