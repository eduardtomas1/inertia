import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeSupervisor } from "../../src/main/runtime-supervisor";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";
import { RuntimeOwnedProcessJournal } from "../../src/node/runtime-owned-processes";
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

function createHarness(): {
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
    startupTimeoutMs: 2_000,
    stableUptimeMs: 5_000,
    shutdownGraceMs: 1_000,
    forceKillWaitMs: 500,
    forceKill,
    recoverOwnedProcesses: () => true,
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
