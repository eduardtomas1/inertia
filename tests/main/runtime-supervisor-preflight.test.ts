import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RuntimeSupervisor } from "../../src/main/runtime-supervisor";
import type { RuntimeWorkerCommand } from
  "../../src/node/runtime-process-protocol";

class PreflightFailureUtilityProcess extends EventEmitter {
  pid: number | undefined = 10_000;
  readonly messages: RuntimeWorkerCommand[] = [];

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

let dataDirectory: string;

function createHarness() {
  const children: PreflightFailureUtilityProcess[] = [];
  const forceKill = vi.fn(() => true);
  const supervisor = new RuntimeSupervisor({
    systemBootId: "test:00000000-0000-4000-8000-000000000001",
    workerOptions: {
      dataDirectory,
      defaultWorkspacePath: tmpdir(),
      enableProviders: false,
    },
    spawn: () => {
      const child = new PreflightFailureUtilityProcess();
      children.push(child);
      return child as never;
    },
    startupTimeoutMs: 2_000,
    stableUptimeMs: 5_000,
    shutdownGraceMs: 100,
    forceKillWaitMs: 500,
    forceKill,
    recoverOwnedProcesses: () => true,
    armProcessContainment: () => process.platform === "win32"
      ? { kind: "windows-job-v1", name: `Global\\InertiaRuntime-${"a".repeat(64)}` }
      : null,
  });
  return { children, forceKill, supervisor };
}

beforeEach(() => {
  vi.useFakeTimers();
  dataDirectory = mkdtempSync(join(tmpdir(), "inertia-preflight-supervisor-"));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  rmSync(dataDirectory, { recursive: true, force: true });
});

it("acknowledges a cleanly stopped preflight failure without forcing cleanup", async () => {
  const { children, forceKill, supervisor } = createHarness();

  supervisor.start();
  children[0].spawn();
  children[0].message({
    type: "runtime.startup-failed",
    message: "Runtime process ownership could not be initialized.",
  });
  children[0].message({ type: "runtime.stopped" });

  expect(children[0].messages.at(-1)).toEqual({
    type: "runtime.stopped-acknowledged",
  });
  children[0].exit(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(forceKill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500);
  expect(children).toHaveLength(2);
});

it.each([
  [
    "prior-runtime-cleanup-unconfirmed" as const,
    "Runtime startup is blocked because prior process cleanup remains unconfirmed." as const,
  ],
  [
    "provider-installation-quarantined" as const,
    "Provider installation recovery requires manual attention." as const,
  ],
])("does not retry the terminal startup blocker %s", async (
  blockerCode,
  message,
) => {
  const { children, supervisor } = createHarness();
  supervisor.start();
  children[0].spawn();
  children[0].message({
    type: "runtime.startup-failed",
    blockerCode,
    message,
  });

  expect(supervisor.snapshot()).toMatchObject({
    phase: "stopping",
    restartScheduled: false,
    startupBlockerCode: blockerCode,
  });
  children[0].message({ type: "runtime.stopped" });
  children[0].exit(1);
  await vi.advanceTimersByTimeAsync(60_000);

  expect(children).toHaveLength(1);
  expect(supervisor.snapshot()).toMatchObject({
    phase: "stopped",
    generation: 1,
    pid: null,
    restartScheduled: false,
    startupBlockerCode: blockerCode,
  });
});
