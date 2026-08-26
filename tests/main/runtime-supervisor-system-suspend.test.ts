import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeSupervisor } from "../../src/main/runtime-supervisor";
import type { RuntimeWorkerCommand } from "../../src/node/runtime-process-protocol";

const readyUrl = `ws://127.0.0.1:41001/runtime/${"a".repeat(43)}`;
let dataDirectory: string;

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined = 12_345;
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

  message(value: unknown): void {
    this.emit("message", value);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  dataDirectory = mkdtempSync(join(tmpdir(), "inertia-suspend-supervisor-"));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("RuntimeSupervisor system suspend acknowledgement", () => {
  it("accepts an acknowledgement only from the current ready runtime", () => {
    const child = new FakeUtilityProcess();
    const acknowledged = vi.fn();
    const supervisor = new RuntimeSupervisor({
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
      workerOptions: {
        dataDirectory,
        defaultWorkspacePath: dataDirectory,
        enableProviders: false,
      },
      spawn: () => child as never,
      recoverOwnedProcesses: () => true,
      onSystemSuspendRecorded: acknowledged,
    });
    const interval = {
      id: "11111111-1111-4111-8111-111111111111",
      suspendedAt: "2026-08-25T12:15:39.000Z",
      resumedAt: "2026-08-25T12:20:00.000Z",
    };

    supervisor.start();
    child.spawn();
    expect(supervisor.recordSystemSuspendInterval(interval)).toBe(false);
    child.message({ type: "runtime.ready", websocketUrl: readyUrl });
    expect(supervisor.recordSystemSuspendInterval(interval)).toBe(true);
    expect(child.messages.at(-1)).toEqual({
      type: "runtime.record-system-suspend",
      interval,
    });
    child.message({
      type: "runtime.system-suspend-recorded",
      id: interval.id,
    });
    expect(acknowledged).toHaveBeenCalledOnce();
    expect(acknowledged).toHaveBeenCalledWith(interval.id);
  });
});
