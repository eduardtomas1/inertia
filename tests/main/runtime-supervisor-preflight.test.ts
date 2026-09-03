import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";
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

it("acknowledges a cleanly stopped preflight failure without forcing cleanup", async () => {
  vi.useFakeTimers();
  const dataDirectory = mkdtempSync(join(tmpdir(), "inertia-preflight-supervisor-"));
  try {
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

    supervisor.start();
    children[0].spawn();
    children[0].message({
      type: "runtime.startup-failed",
      message: "The Linux runtime process guardian sandbox self-test failed.",
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
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
