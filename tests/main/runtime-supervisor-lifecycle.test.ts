import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeSupervisor } from "../../src/main/runtime-supervisor";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";
import { RuntimeOwnedProcessJournal } from "../../src/node/runtime-owned-processes";
import type { RuntimeOwnedProcessContainment } from
  "../../src/node/runtime-owned-processes";
import type { RuntimeWorkerCommand } from "../../src/node/runtime-process-protocol";

const runtimeUrl = `ws://127.0.0.1:41001/runtime/${"a".repeat(43)}`;
let dataDirectory: string;

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined;
  readonly messages: RuntimeWorkerCommand[] = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  postMessage(message: RuntimeWorkerCommand): void {
    this.messages.push(message);
  }

  kill(): boolean { return true; }
  spawn(): void { this.emit("spawn"); }
  message(value: unknown): void { this.emit("message", value); }
  exit(code: number): void {
    this.emit("exit", code);
    this.pid = undefined;
  }
}

function createHarness(options: {
  startupTimeoutMs?: number;
  recoverOwnedProcesses?: (
    runtimeGenerationId: string,
    systemBootId: string,
    deadlineAt: number,
  ) => boolean | Promise<boolean> | null;
  armProcessContainment?: () =>
    RuntimeOwnedProcessContainment
    | Promise<RuntimeOwnedProcessContainment | null>
    | null;
} = {}): {
  children: FakeUtilityProcess[];
  forceKill: ReturnType<typeof vi.fn<(pid: number, deadlineAt: number) => boolean>>;
  supervisor: RuntimeSupervisor;
} {
  const children: FakeUtilityProcess[] = [];
  const forceKill = vi.fn((_pid: number, _deadlineAt: number) => true);
  const supervisor = new RuntimeSupervisor({
    systemBootId: "test:00000000-0000-4000-8000-000000000001",
    workerOptions: {
      dataDirectory,
      defaultWorkspacePath: resolve(tmpdir(), "inertia workspace"),
      enableProviders: false,
    },
    spawn: () => {
      const child = new FakeUtilityProcess(10_000 + children.length);
      children.push(child);
      return child as never;
    },
    startupTimeoutMs: options.startupTimeoutMs ?? 2_000,
    stableUptimeMs: 5_000,
    shutdownGraceMs: 1_000,
    forceKillWaitMs: 500,
    forceKill,
    recoverOwnedProcesses: options.recoverOwnedProcesses ?? (() => true),
    armProcessContainment: options.armProcessContainment ?? (() =>
      process.platform === "win32"
        ? {
            kind: "windows-job-v1",
            name: `Global\\InertiaRuntime-${"a".repeat(64)}`,
          }
        : null),
  });
  return { children, forceKill, supervisor };
}

beforeEach(() => {
  vi.useFakeTimers();
  dataDirectory = mkdtempSync(join(tmpdir(), "inertia-supervisor-lifecycle-"));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("RuntimeSupervisor lifecycle", () => {
  it("recovers exact owned claims after an unconfirmed close before restarting", async () => {
    const recoverOwnedProcesses = vi.fn(async () => true);
    const { children, supervisor } = createHarness({ recoverOwnedProcesses });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: runtimeUrl });

    children[0].message({ type: "runtime.shutdown-unconfirmed" });
    expect(supervisor.snapshot()).toMatchObject({
      phase: "restarting",
      websocketUrl: null,
    });
    expect(() => supervisor.connection()).toThrow(
      "could not confirm complete process cleanup",
    );
    children[0].exit(137);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);

    expect(recoverOwnedProcesses).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f-]{36}:1$/u),
      "test:00000000-0000-4000-8000-000000000001",
      expect.any(Number),
    );
    expect(children).toHaveLength(2);
    children[1].spawn();
    expect(children[1].messages.at(-1)).toMatchObject({
      type: "runtime.start",
      options: {
        confirmedTerminatedRuntimeGenerationIds: [
          expect.stringMatching(/^[0-9a-f-]{36}:1$/u),
        ],
      },
    });
    expect(children[1].messages.at(-1)).not.toMatchObject({
      options: { priorRuntimeCleanupUnconfirmed: true },
    });
  });

  it("settles stop when pending exact cleanup recovery fails", async () => {
    let resolveRecovery!: (recovered: boolean) => void;
    const recoverOwnedProcesses = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveRecovery = resolve;
    }));
    const { children, supervisor } = createHarness({ recoverOwnedProcesses });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: runtimeUrl });

    children[0].message({ type: "runtime.shutdown-unconfirmed" });
    children[0].exit(137);
    await vi.advanceTimersByTimeAsync(0);
    const stopped = supervisor.stop();
    resolveRecovery(false);
    await vi.advanceTimersByTimeAsync(0);

    await expect(stopped).resolves.toBe(false);
    expect(children).toHaveLength(1);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      restartScheduled: false,
    });
  });

  it("stays blocked instead of starting a safety-locked replacement", async () => {
    const recoverOwnedProcesses = vi.fn(() => false);
    const { children, supervisor } = createHarness({ recoverOwnedProcesses });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: runtimeUrl });

    children[0].message({ type: "runtime.shutdown-unconfirmed" });
    children[0].exit(137);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(recoverOwnedProcesses).toHaveBeenCalledOnce();
    expect(children).toHaveLength(1);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      restartScheduled: false,
    });
  });

  it("fails closed when exact cleanup recovery throws synchronously", async () => {
    const recoverOwnedProcesses = vi.fn((): boolean => {
      throw new Error("journal unavailable");
    });
    const { children, supervisor } = createHarness({ recoverOwnedProcesses });
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: runtimeUrl });

    children[0].message({ type: "runtime.shutdown-unconfirmed" });
    expect(() => children[0].exit(137)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    expect(children).toHaveLength(1);
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      restartScheduled: false,
    });
  });

  it("starts readiness timing after slow asynchronous containment admission", async () => {
    let resolveContainment!: (
      containment: RuntimeOwnedProcessContainment | null,
    ) => void;
    const containmentPending =
      new Promise<RuntimeOwnedProcessContainment | null>((resolve) => {
        resolveContainment = resolve;
      });
    const { children, forceKill, supervisor } = createHarness({
      startupTimeoutMs: 20_000,
      armProcessContainment: () => containmentPending,
    });
    supervisor.start();
    children[0].spawn();

    await vi.advanceTimersByTimeAsync(32_751);
    expect(children[0].messages).not.toContainEqual(expect.objectContaining({
      type: "runtime.start",
    }));
    expect(forceKill).not.toHaveBeenCalled();

    resolveContainment(process.platform === "win32"
      ? {
          kind: "windows-job-v1",
          name: `Global\\InertiaRuntime-${"a".repeat(64)}`,
        }
      : null);
    await Promise.resolve();
    await Promise.resolve();
    expect(children[0].messages).toContainEqual(expect.objectContaining({
      type: "runtime.start",
    }));

    await vi.advanceTimersByTimeAsync(19_999);
    expect(forceKill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(forceKill).toHaveBeenCalledWith(10_000, expect.any(Number));
    expect(() => supervisor.connection()).toThrow("did not become ready");
  });

  it("is single-use after a complete owned-generation shutdown", async () => {
    const { children, forceKill, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    const start = children[0].messages.find(
      (message) => message.type === "runtime.start",
    );
    if (start?.type !== "runtime.start") {
      throw new Error("Expected the first runtime generation to start.");
    }
    children[0].message({ type: "runtime.ready", websocketUrl: runtimeUrl });

    const firstStop = supervisor.stop();
    children[0].message({ type: "runtime.stopped" });
    children[0].exit(0);
    await expect(firstStop).resolves.toBe(true);
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()).toEqual([]);
    expect(new RuntimeOwnedProcessJournal(dataDirectory)
      .records(start.options.runtimeGenerationId)).toBeNull();

    supervisor.start();
    const secondStop = supervisor.stop();

    expect(secondStop).toBe(firstStop);
    await expect(secondStop).resolves.toBe(true);
    expect(children).toHaveLength(1);
    expect(children[0].messages.filter(
      (message) => message.type === "runtime.shutdown",
    )).toHaveLength(1);
    expect(forceKill).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      generation: 1,
      pid: null,
      restartScheduled: false,
    });
  });

  it.each([
    [
      "owned-process-tainted",
      "The runtime restarted because owned process containment could not be confirmed.",
    ],
    [
      "owned-process-cleanup-unconfirmed",
      "The runtime restarted because owned process cleanup could not be confirmed.",
    ],
  ] as const)("preserves the bounded %s restart reason", (reason, message) => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: runtimeUrl });
    children[0].message({ type: "runtime.restart-requested", reason });
    children[0].exit(1);

    expect(supervisor.snapshot()).toMatchObject({
      phase: "restarting",
      lastError: message,
    });
  });

  it("does not start after shutdown closes an unused supervisor", async () => {
    const { children, forceKill, supervisor } = createHarness();

    const firstStop = supervisor.stop();
    await expect(firstStop).resolves.toBe(true);
    supervisor.start();

    expect(supervisor.stop()).toBe(firstStop);
    expect(children).toHaveLength(0);
    expect(forceKill).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).toMatchObject({
      phase: "stopped",
      generation: 0,
      pid: null,
      restartScheduled: false,
    });
  });
});
