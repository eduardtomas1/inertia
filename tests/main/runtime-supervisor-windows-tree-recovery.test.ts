import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeSupervisor } from "../../src/main/runtime-supervisor";
import { windowsRuntimeJobName } from "../../src/main/windows-runtime-job";
import type { RuntimeOwnedProcessContainment } from
  "../../src/node/runtime-owned-processes";
import type { RuntimeWorkerCommand } from
  "../../src/node/runtime-process-protocol";

const systemBootId = "test:00000000-0000-4000-8000-000000000001";
const runtimeUrl = `ws://127.0.0.1:41001/runtime/${"a".repeat(43)}`;
let dataDirectory: string;

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined = 10_000;
  readonly messages: RuntimeWorkerCommand[] = [];

  postMessage(message: RuntimeWorkerCommand): void {
    this.messages.push(message);
  }

  kill(): boolean {
    return true;
  }

  spawn(): void {
    this.emit("spawn");
  }

  message(message: unknown): void {
    this.emit("message", message);
  }

  exit(code: number): void {
    this.emit("exit", code);
    this.pid = undefined;
  }
}

function createHarness(options: {
  recoverOwnedProcesses: (
    runtimeGenerationId: string,
    systemBootId: string,
    deadlineAt: number,
  ) => boolean | Promise<boolean> | null;
  armProcessContainment?: (
    runtimeGenerationId: string,
    runtimePid: number,
    admission?: { readonly isCurrent: () => boolean },
  ) => RuntimeOwnedProcessContainment
    | Promise<RuntimeOwnedProcessContainment | null>
    | null;
}) {
  const children: FakeUtilityProcess[] = [];
  const forceKill = vi.fn(() => false);
  const supervisor = new RuntimeSupervisor({
    systemBootId,
    workerOptions: {
      dataDirectory,
      defaultWorkspacePath: resolve(tmpdir(), "inertia-windows-tree-workspace"),
      enableProviders: false,
    },
    spawn: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child as never;
    },
    startupTimeoutMs: 2_000,
    stableUptimeMs: 5_000,
    shutdownGraceMs: 100,
    forceKillWaitMs: 50,
    forceKill,
    recoverOwnedProcesses: options.recoverOwnedProcesses,
    armProcessContainment: options.armProcessContainment
      ?? ((runtimeGenerationId) => ({
        kind: "windows-job-v1",
        name: windowsRuntimeJobName(runtimeGenerationId),
      })),
  });
  return { children, forceKill, supervisor };
}

beforeEach(() => {
  vi.useFakeTimers();
  dataDirectory = mkdtempSync(join(tmpdir(), "inertia-windows-tree-recovery-"));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe.runIf(process.platform === "win32")(
  "Windows runtime tree recovery",
  () => {
    it("recovers an unconfirmed shutdown after taskkill loses the exit race", async () => {
      const recoverOwnedProcesses = vi.fn(async () => true);
      const { children, forceKill, supervisor } = createHarness({
        recoverOwnedProcesses,
      });
      supervisor.start();
      children[0]!.spawn();
      children[0]!.message({ type: "runtime.ready", websocketUrl: runtimeUrl });

      const stopped = supervisor.stop();
      children[0]!.message({
        type: "runtime.shutdown-unconfirmed",
        reason: "owned-process-cleanup",
      });
      children[0]!.exit(137);

      await expect(stopped).resolves.toBe(true);
      expect(forceKill).toHaveBeenCalledOnce();
      expect(recoverOwnedProcesses).toHaveBeenCalledOnce();
      expect(supervisor.snapshot()).toMatchObject({
        phase: "stopped",
        pid: null,
        lastError: null,
      });
    });

    it("recovers trusted stopped after taskkill loses the exit race", async () => {
      const recoverOwnedProcesses = vi.fn(async () => true);
      const { children, forceKill, supervisor } = createHarness({
        recoverOwnedProcesses,
      });
      supervisor.start();
      children[0]!.spawn();
      children[0]!.message({ type: "runtime.ready", websocketUrl: runtimeUrl });

      const stopped = supervisor.stop();
      await vi.advanceTimersByTimeAsync(100);
      children[0]!.message({ type: "runtime.stopped" });
      children[0]!.exit(0);

      await expect(stopped).resolves.toBe(true);
      expect(forceKill).toHaveBeenCalledOnce();
      expect(recoverOwnedProcesses).toHaveBeenCalledOnce();
      expect(supervisor.snapshot()).toMatchObject({
        phase: "stopped",
        pid: null,
        lastError: null,
      });
    });

    it("rejects recycle when taskkill and exact recovery both fail", async () => {
      const recoverOwnedProcesses = vi.fn(async () => false);
      const { children, forceKill, supervisor } = createHarness({
        recoverOwnedProcesses,
      });
      supervisor.start();
      children[0]!.spawn();
      children[0]!.message({ type: "runtime.ready", websocketUrl: runtimeUrl });

      const recycled = supervisor.testOnlyRecycle();
      const rejected = expect(recycled).rejects.toThrow(/process tree/u);
      await vi.advanceTimersByTimeAsync(100);
      children[0]!.message({ type: "runtime.stopped" });
      children[0]!.exit(0);

      await rejected;
      expect(forceKill).toHaveBeenCalledOnce();
      expect(recoverOwnedProcesses).toHaveBeenCalledOnce();
      expect(supervisor.snapshot()).toMatchObject({
        phase: "stopped",
        pid: null,
        restartScheduled: false,
      });
    });

    it("does not recover a false tree result before containment is durable", async () => {
      let resolveContainment!: (
        containment: RuntimeOwnedProcessContainment | null,
      ) => void;
      const armProcessContainment = vi.fn(() =>
        new Promise<RuntimeOwnedProcessContainment | null>((resolvePromise) => {
          resolveContainment = resolvePromise;
        }));
      const recoverOwnedProcesses = vi.fn(async () => true);
      const { children, forceKill, supervisor } = createHarness({
        armProcessContainment,
        recoverOwnedProcesses,
      });
      supervisor.start();
      children[0]!.spawn();

      const stopped = supervisor.stop();
      await vi.advanceTimersByTimeAsync(100);
      children[0]!.exit(137);

      await expect(stopped).resolves.toBe(false);
      expect(forceKill).toHaveBeenCalledOnce();
      expect(recoverOwnedProcesses).not.toHaveBeenCalled();
      expect(supervisor.snapshot()).toMatchObject({
        phase: "stopped",
        pid: null,
      });

      resolveContainment({
        kind: "windows-job-v1",
        name: windowsRuntimeJobName(
          "00000000-0000-4000-8000-000000000002:1",
        ),
      });
      await Promise.resolve();
      expect(recoverOwnedProcesses).not.toHaveBeenCalled();
    });
  },
);
