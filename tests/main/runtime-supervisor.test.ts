import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RuntimeSupervisor,
  runtimeRestartDelayMs,
} from "../../src/main/runtime-supervisor";
import type { RuntimeWorkerCommand } from "../../src/main/runtime-process-protocol";

const firstUrl = `ws://127.0.0.1:41001/runtime/${"a".repeat(43)}`;
const secondUrl = `ws://127.0.0.1:41002/runtime/${"b".repeat(43)}`;
const dataDirectory = resolve(tmpdir(), "inertia data");
const workspaceDirectory = resolve(tmpdir(), "inertia workspace");

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined;
  readonly messages: RuntimeWorkerCommand[] = [];
  killCalls = 0;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  postMessage(message: RuntimeWorkerCommand): void {
    this.messages.push(message);
  }

  kill(): boolean {
    this.killCalls += 1;
    return true;
  }

  spawn(): void { this.emit("spawn"); }
  message(value: unknown): void { this.emit("message", value); }
  exit(code: number): void {
    this.emit("exit", code);
    this.pid = undefined;
  }
}

function createHarness(options: { stableUptimeMs?: number; shutdownGraceMs?: number; forceKillWaitMs?: number } = {}) {
  const children: FakeUtilityProcess[] = [];
  const forceKill = vi.fn();
  const supervisor = new RuntimeSupervisor({
    workerOptions: {
      dataDirectory,
      defaultWorkspacePath: workspaceDirectory,
      enableProviders: false,
    },
    spawn: () => {
      const child = new FakeUtilityProcess(10_000 + children.length);
      children.push(child);
      return child as never;
    },
    startupTimeoutMs: 2_000,
    stableUptimeMs: options.stableUptimeMs ?? 5_000,
    shutdownGraceMs: options.shutdownGraceMs ?? 1_000,
    forceKillWaitMs: options.forceKillWaitMs ?? 500,
    forceKill,
  });
  return { children, forceKill, supervisor };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("RuntimeSupervisor", () => {
  it("waits for authenticated readiness before handing out a connection", () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    expect(children).toHaveLength(1);
    expect(() => supervisor.connection()).toThrow("local service is starting");

    children[0].spawn();
    expect(children[0].messages).toEqual([{
      type: "runtime.start",
      options: {
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: false,
      },
    }]);
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });

    expect(supervisor.connection()).toEqual({ websocketUrl: firstUrl });
    expect(supervisor.snapshot()).toMatchObject({ phase: "ready", generation: 1, pid: 10_000 });
  });

  it("reports startup failure and retries only after the failed child exits", () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.startup-failed", message: "The database is locked." });

    expect(() => supervisor.connection()).toThrow("The database is locked");
    vi.advanceTimersByTime(10_000);
    expect(children).toHaveLength(1);

    children[0].exit(1);
    expect(supervisor.snapshot()).toMatchObject({ phase: "restarting", restartAttempt: 1, restartScheduled: true });
    vi.advanceTimersByTime(499);
    expect(children).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(children).toHaveLength(2);
  });

  it("rotates the capability URL after an unexpected crash without duplicating a live child", () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    children[0].exit(9);
    children[0].exit(9);

    vi.advanceTimersByTime(500);
    expect(children).toHaveLength(2);
    children[1].spawn();
    children[1].message({ type: "runtime.ready", websocketUrl: secondUrl });
    expect(supervisor.connection()).toEqual({ websocketUrl: secondUrl });
    expect(supervisor.snapshot()).toMatchObject({ phase: "ready", generation: 2 });
  });

  it("uses bounded exponential backoff and resets it only after stable readiness", () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(runtimeRestartDelayMs)).toEqual([500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
    const { children, supervisor } = createHarness({ stableUptimeMs: 2_000 });
    supervisor.start();
    children[0].spawn();
    children[0].exit(1);
    vi.advanceTimersByTime(500);
    children[1].spawn();
    children[1].message({ type: "runtime.ready", websocketUrl: firstUrl });
    expect(supervisor.snapshot().restartAttempt).toBe(1);
    vi.advanceTimersByTime(1_999);
    expect(supervisor.snapshot().restartAttempt).toBe(1);
    vi.advanceTimersByTime(1);
    expect(supervisor.snapshot().restartAttempt).toBe(0);
  });

  it("kills a child that never becomes ready and waits for exit before replacing it", () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    vi.advanceTimersByTime(2_000);
    expect(children[0].killCalls).toBe(1);
    expect(children).toHaveLength(1);
    expect(() => supervisor.connection()).toThrow("did not become ready");
    children[0].exit(1);
    vi.advanceTimersByTime(500);
    expect(children).toHaveLength(2);
  });

  it("shuts down cleanly without restart and escalates only when grace expires", async () => {
    const { children, forceKill, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].message({ type: "runtime.ready", websocketUrl: firstUrl });
    const stopped = supervisor.stop();
    expect(children[0].messages.at(-1)).toEqual({ type: "runtime.shutdown" });
    children[0].exit(0);
    await stopped;
    vi.runAllTimers();
    expect(children).toHaveLength(1);
    expect(children[0].killCalls).toBe(0);
    expect(forceKill).not.toHaveBeenCalled();
    expect(supervisor.snapshot().phase).toBe("stopped");
  });

  it("allows the normal main quit only after the worker exits", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    const quitMain = vi.fn();
    const stopped = supervisor.stop().then(quitMain);
    children[0].message({ type: "runtime.stopped" });
    await Promise.resolve();
    expect(quitMain).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).toMatchObject({ phase: "stopping", pid: 10_000, restartScheduled: false });
    children[0].exit(0);
    await stopped;
    expect(quitMain).toHaveBeenCalledOnce();
    expect(supervisor.snapshot()).toMatchObject({ phase: "stopped", pid: null, restartScheduled: false });
    vi.advanceTimersByTime(60_000);
    expect(children).toHaveLength(1);
  });

  it("settles after forcing an unresponsive utility process and never starts a replacement", async () => {
    const { children, forceKill, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    const stopped = supervisor.stop();
    vi.advanceTimersByTime(1_000);
    expect(children[0].killCalls).toBe(1);
    vi.advanceTimersByTime(500);
    expect(forceKill).toHaveBeenCalledWith(10_000);
    vi.advanceTimersByTime(500);
    expect(forceKill).toHaveBeenCalledTimes(2);
    await stopped;
    expect(supervisor.snapshot()).toMatchObject({ phase: "stopped", pid: null, lastError: expect.stringContaining("shutdown deadline") });
    children[0].exit(137);
    vi.advanceTimersByTime(60_000);
    expect(children).toHaveLength(1);
  });

  it("cancels a pending restart on intentional shutdown", async () => {
    const { children, supervisor } = createHarness();
    supervisor.start();
    children[0].spawn();
    children[0].exit(1);
    expect(supervisor.snapshot().restartScheduled).toBe(true);
    await supervisor.stop();
    vi.advanceTimersByTime(60_000);
    expect(children).toHaveLength(1);
    expect(supervisor.snapshot().phase).toBe("stopped");
  });
});
