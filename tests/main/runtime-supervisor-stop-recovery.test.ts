// @inertia-test-suite portable

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeSupervisor, type RuntimeSupervisorSnapshot } from "../../src/main/runtime-supervisor";
import {
  reconcileStoppedRuntimeQuarantine,
  runtimePriorCleanupEvidence,
  runtimeStopAttemptState,
  trackRuntimeStopAttempt,
} from "../../src/main/runtime-supervisor-stop-recovery";
import { createRuntimeProcessRecord } from "../../src/main/runtime-supervisor-process-record";
import type { RuntimeWorkerCommand } from "../../src/node/runtime-process-protocol";

describe("prior runtime cleanup evidence", () => {
  const record = (generation: number, exited: boolean) => ({
    ...createRuntimeProcessRecord({
      child: {} as never,
      generation,
      runtimeGenerationId: `00000000-0000-4000-8000-000000000001:${generation}`,
      cleanupReceiptIds: [],
    }),
    exited,
  });

  it("names exited generations and locks only for a worker whose exit was not observed", () => {
    expect(runtimePriorCleanupEvidence([])).toEqual({});
    expect(runtimePriorCleanupEvidence([record(1, true), record(2, true)])).toEqual({
      exitedUnconfirmedRuntimeGenerationIds: [
        "00000000-0000-4000-8000-000000000001:1",
        "00000000-0000-4000-8000-000000000001:2",
      ],
    });
    expect(runtimePriorCleanupEvidence([record(1, true), record(2, false)])).toEqual({
      priorRuntimeCleanupUnconfirmed: true,
      exitedUnconfirmedRuntimeGenerationIds: ["00000000-0000-4000-8000-000000000001:1"],
    });
  });

  it("locks instead of naming more exited generations than the worker accepts", () => {
    const records = Array.from({ length: 33 }, (_, index) => record(index + 1, true));
    expect(runtimePriorCleanupEvidence(records.slice(0, 32))
      .exitedUnconfirmedRuntimeGenerationIds).toHaveLength(32);
    expect(runtimePriorCleanupEvidence(records)).toEqual({
      priorRuntimeCleanupUnconfirmed: true,
    });
  });

  it("retires every generation reconciliation confirms even after one it cannot", async () => {
    const stuck = { ...record(1, true), generationCleanupConfirmed: true };
    const confirmed = {
      ...record(2, true), cleanupConfirmed: true, generationCleanupConfirmed: true,
    };
    const records = new Set([stuck, confirmed]);
    const clear = vi.fn();
    await expect(reconcileStoppedRuntimeQuarantine({
      records,
      drain: async (candidate) => candidate === confirmed,
      recoverOwnedProcesses: () => false,
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
      recoveryWaitMs: 1_000,
      cleanupReceipts: {} as never,
      runtimeGenerationLeases: {} as never,
      runtimeOwnedProcesses: {} as never,
      onPersistenceFailure: vi.fn(),
      clear,
    })).resolves.toBe(false);
    expect([...records]).toEqual([stuck]);
    expect(clear).toHaveBeenCalledExactlyOnceWith(confirmed);
  });
});

describe("stopped-runtime recovery admission", () => {
  it("makes only an unsuccessful stop retryable", async () => {
    const state = runtimeStopAttemptState();
    const confirmed = trackRuntimeStopAttempt(state, Promise.resolve(true));
    await expect(confirmed).resolves.toBe(true);
    expect(state.promise).toBe(confirmed);
    expect(state.retryEligible).toBe(false);

    const failed = runtimeStopAttemptState();
    await expect(trackRuntimeStopAttempt(failed, Promise.resolve(false)))
      .resolves.toBe(false);
    expect(failed).toMatchObject({ promise: null, retryEligible: true });
  });

  it("releases a rejected stop attempt without hiding its error", async () => {
    const state = runtimeStopAttemptState();
    const tracked = trackRuntimeStopAttempt(
      state,
      Promise.reject(new Error("shutdown rejected")),
    );
    await expect(tracked).rejects.toThrow("shutdown rejected");
    expect(state).toMatchObject({ promise: null, retryEligible: true });
  });
});

class FakeStopUtilityProcess extends EventEmitter {
  pid: number | undefined;
  readonly messages: RuntimeWorkerCommand[] = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  postMessage(message: RuntimeWorkerCommand): void { this.messages.push(message); }
  kill(): boolean { return true; }
  spawn(): void { this.emit("spawn"); }
  message(value: unknown): void { this.emit("message", value); }
  exit(code: number): void {
    this.emit("exit", code);
    this.pid = undefined;
  }
}

describe("RuntimeSupervisor stop retry and shutdown phase transitions", () => {
  const directories: string[] = [];

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function createStopHarness(options: {
    forceKill: (pid: number, deadlineAt: number) => boolean | Promise<boolean>;
    onStateChange?: (snapshot: RuntimeSupervisorSnapshot) => void;
    recoverOwnedProcesses?: () => boolean | Promise<boolean>;
  }) {
    const dataDirectory = mkdtempSync(join(tmpdir(), "inertia-supervisor-stop-retry-"));
    directories.push(dataDirectory);
    const children: FakeStopUtilityProcess[] = [];
    const supervisor = new RuntimeSupervisor({
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
      workerOptions: {
        dataDirectory,
        defaultWorkspacePath: resolve(tmpdir(), "inertia workspace"),
        enableProviders: false,
      },
      spawn: () => {
        const child = new FakeStopUtilityProcess(20_000 + children.length);
        children.push(child);
        return child as never;
      },
      startupTimeoutMs: 2_000,
      stableUptimeMs: 5_000,
      shutdownGraceMs: 50,
      forceKillWaitMs: 25,
      forceKill: options.forceKill,
      recoverOwnedProcesses: options.recoverOwnedProcesses ?? (() => true),
      armProcessContainment: () => (
        process.platform === "win32"
          ? { kind: "windows-job-v1", name: `Global\\InertiaRuntime-${"b".repeat(64)}` }
          : null
      ),
      onStateChange: options.onStateChange,
    });
    return { children, supervisor };
  }

  async function bootReady(
    supervisor: RuntimeSupervisor,
    children: FakeStopUtilityProcess[],
  ): Promise<FakeStopUtilityProcess> {
    supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    const child = children[0]!;
    child.spawn();
    child.message({
      type: "runtime.ready",
      websocketUrl: `ws://127.0.0.1:41002/runtime/${"a".repeat(43)}`,
      pid: child.pid,
    });
    await vi.advanceTimersByTimeAsync(0);
    return child;
  }

  it("re-invokes forceKill when stop() is retried after an unconfirmed force-termination timeout", async () => {
    vi.useFakeTimers();
    let forceKillCalls = 0;
    let currentChild: FakeStopUtilityProcess | null = null;
    const { children, supervisor } = createStopHarness({
      forceKill: () => {
        forceKillCalls += 1;
        if (forceKillCalls === 1) return false;
        currentChild?.exit(1);
        return true;
      },
    });
    currentChild = await bootReady(supervisor, children);

    const firstStop = supervisor.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(firstStop).resolves.toBe(false);
    expect(forceKillCalls).toBe(1);

    const secondStop = supervisor.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(secondStop).resolves.toBe(true);
    expect(forceKillCalls).toBe(2);
    expect(supervisor.snapshot().phase).toBe("stopped");
  });

  it("never emits restarting phase when the child exits during stop() while process-tree termination is pending", async () => {
    vi.useFakeTimers();
    const phasesAfterStop: string[] = [];
    let recording = false;
    let resolveForceKill!: (confirmed: boolean) => void;
    const forceKillDeferred = new Promise<boolean>((resolve) => { resolveForceKill = resolve; });
    const { children, supervisor } = createStopHarness({
      forceKill: () => forceKillDeferred,
      onStateChange: (snapshot) => {
        if (recording) phasesAfterStop.push(snapshot.phase);
      },
    });
    const child = await bootReady(supervisor, children);

    recording = true;
    const stopping = supervisor.stop();
    await vi.advanceTimersByTimeAsync(50);
    child.exit(1);
    await vi.advanceTimersByTimeAsync(0);
    resolveForceKill(true);
    await vi.advanceTimersByTimeAsync(50);

    await expect(stopping).resolves.toBe(true);
    expect(phasesAfterStop).not.toContain("restarting");
    expect(phasesAfterStop.at(-1)).toBe("stopped");
  });
});
