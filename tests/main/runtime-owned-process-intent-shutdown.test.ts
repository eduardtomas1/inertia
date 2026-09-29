import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  awaitRuntimeOwnedProcessCleanupConfirmed,
  awaitRuntimeOwnedProcessStopped,
  confirmRuntimeOwnedProcessStopped,
  RuntimeOwnedProcessJournal,
  spawnRuntimeOwnedProcess,
} from "../../src/node/runtime-owned-processes";
import type { RuntimeWorkerEvent } from "../../src/node/runtime-process-protocol";
import { RUNTIME_SHUTDOWN_DEADLINE_MS } from "../../src/server/runtime-shutdown";
import {
  createOwnedProcessTreeTermination,
  terminateProcessTreeAndWait,
} from "../../src/server/process-lifecycle";
import { completeRuntimeWorkerShutdown } from "../../src/server/runtime-worker-shutdown";
import { activatePreparedRuntimeOwnedProcessRegistry } from
  "../helpers/prepared-runtime-owned-process-registry";

const systemBootId = "test:64000000-0000-4000-8000-000000000064";
const runtimeGenerationId = "65000000-0000-4000-8000-000000000065:1";
const directories: string[] = [];
let deactivate: (() => void) | null = null;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  deactivate?.();
  deactivate = null;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe.each(["darwin", "win32"] as const)("%s shutdown joins pending spawn-intent retirement", (platform) => {
  const activate = (): string => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-owned-intent-shutdown-"));
    directories.push(directory);
    deactivate = activatePreparedRuntimeOwnedProcessRegistry(
      directory,
      runtimeGenerationId,
      systemBootId,
      {
        platform,
        ...(platform === "win32" ? {} : { darwinGuardianPath: process.execPath }),
      },
    );
    return directory;
  };
  const failedSpawn = async (directory: string): Promise<ChildProcess> => {
    const child = spawnRuntimeOwnedProcess(() => spawn(
      process.execPath,
      ["-e", ""],
      { cwd: join(directory, "deleted-worktree"), detached: platform !== "win32", shell: false, stdio: "pipe" },
    ));
    child.once("error", () => undefined);
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    return child;
  };
  const journalWritableAfter = (delayMs: number) => {
    const writableAt = Date.now() + delayMs;
    const release = RuntimeOwnedProcessJournal.prototype.release;
    return vi.spyOn(RuntimeOwnedProcessJournal.prototype, "release")
      .mockImplementation(function (this: RuntimeOwnedProcessJournal, ownershipId: string) {
        if (Date.now() < writableAt) throw new Error("EBUSY");
        return release.call(this, ownershipId);
      });
  };
  const shutdown = (closeDelayMs = 0) => {
    const events: Array<{ type: string; at: number }> = [];
    const startedAt = Date.now();
    void completeRuntimeWorkerShutdown({
      runtime: {
        close: () => new Promise<void>((resolve) => { setTimeout(resolve, closeDelayMs); }),
      } as never,
      cause: "runtime-shutdown",
      exitCode: 0,
      closeBrokers: () => undefined,
      ownedProcessCleanupConfirmed: awaitRuntimeOwnedProcessCleanupConfirmed,
      post: (event: RuntimeWorkerEvent) => { events.push({ type: event.type, at: Date.now() - startedAt }); },
      awaitStoppedAcknowledgement: async () => undefined,
      exit: () => undefined,
    });
    return events;
  };
  const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

  it("confirms shutdown once a scheduled retry retires an intent whose journal becomes writable at 300 ms", async () => {
    const directory = activate();
    fakeClock();
    journalWritableAfter(300);
    const child = await failedSpawn(directory);
    const events = shutdown();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(600);
    expect(events).toEqual([{ type: "runtime.stopped", at: 500 }]);
    expect(confirmRuntimeOwnedProcessStopped(child)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports unconfirmed when the retry schedule is exhausted, without waiting for the shutdown deadline", async () => {
    const directory = activate();
    fakeClock();
    const release = journalWritableAfter(Number.POSITIVE_INFINITY);
    await failedSpawn(directory);
    const events = shutdown();
    await vi.advanceTimersByTimeAsync(2_200);
    expect(events).toEqual([{ type: "runtime.shutdown-unconfirmed", at: 2_100 }]);
    expect(events[0]!.at).toBeLessThan(RUNTIME_SHUTDOWN_DEADLINE_MS);
    expect(release.mock.calls.length).toBeLessThanOrEqual(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports unconfirmed at the shutdown deadline when the next retry would land after it", async () => {
    const directory = activate();
    fakeClock();
    journalWritableAfter(Number.POSITIVE_INFINITY);
    const events = shutdown(RUNTIME_SHUTDOWN_DEADLINE_MS - 50);
    await vi.advanceTimersByTimeAsync(RUNTIME_SHUTDOWN_DEADLINE_MS - 60);
    await failedSpawn(directory);
    await vi.advanceTimersByTimeAsync(60);
    expect(events).toEqual([{ type: "runtime.shutdown-unconfirmed", at: RUNTIME_SHUTDOWN_DEADLINE_MS }]);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(events).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("makes one final attempt when the registry deactivates mid-retry and nothing runs afterwards", async () => {
    const directory = activate();
    fakeClock();
    const release = journalWritableAfter(50);
    const child = await failedSpawn(directory);
    await vi.advanceTimersByTimeAsync(60);
    const retired = awaitRuntimeOwnedProcessStopped(child);
    deactivate?.();
    deactivate = null;
    const callsAtDeactivation = release.mock.calls.length;
    expect(new RuntimeOwnedProcessJournal(directory, { platform }).records(runtimeGenerationId)).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(release.mock.calls.length).toBe(callsAtDeactivation);
    await expect(retired).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  const terminateFromErrorListener = (directory: string, waitMs: number) => {
    const child = spawnRuntimeOwnedProcess(() => spawn(
      process.execPath,
      ["-e", ""],
      { cwd: join(directory, "deleted-worktree"), detached: platform !== "win32", shell: false, stdio: "pipe" },
    ));
    const order: string[] = [];
    let outcome: "confirmed" | "unconfirmed" | undefined;
    let settledAt: number | undefined;
    const startedAt = Date.now();
    child.once("error", () => {
      order.push("error");
      void createOwnedProcessTreeTermination(
        child,
        "Provider update process tree",
        (ownedChild, force) => terminateProcessTreeAndWait(ownedChild, force, { platform, waitMs }),
      )(false).then(
        () => { outcome = "confirmed"; settledAt = Date.now() - startedAt; },
        () => { outcome = "unconfirmed"; settledAt = Date.now() - startedAt; },
      );
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => { order.push("close"); resolve(); }));
    return { child, order, closed, outcome: () => outcome, settledAt: () => settledAt };
  };

  it("confirms an owned termination started from the caller's error listener once the retry retires the intent", async () => {
    const directory = activate();
    fakeClock();
    const release = journalWritableAfter(50);
    const run = terminateFromErrorListener(directory, 1_000);
    await run.closed;
    expect(run.order).toEqual(["error", "close"]);
    await vi.advanceTimersByTimeAsync(99);
    expect(run.outcome()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(run.outcome()).toBe("confirmed");
    expect(run.settledAt()).toBe(100);
    expect(confirmRuntimeOwnedProcessStopped(run.child)).toBe(true);
    expect(release).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports an owned termination unconfirmed at its own deadline when the retry would land later", async () => {
    const directory = activate();
    fakeClock();
    journalWritableAfter(50);
    const run = terminateFromErrorListener(directory, 30);
    await run.closed;
    await vi.advanceTimersByTimeAsync(200);
    expect(run.outcome()).toBe("unconfirmed");
    expect(run.settledAt()).toBe(60);
    expect(confirmRuntimeOwnedProcessStopped(run.child)).toBe(true);
  });
});
