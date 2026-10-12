import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RuntimeSupervisor } from "../../src/main/runtime-supervisor";
import type { RuntimeWorkerCommand } from "../../src/node/runtime-process-protocol";
import { emptyMascotStatus } from "../../src/shared/mascot";

const readyUrl = `ws://127.0.0.1:41001/runtime/${"a".repeat(43)}`;
let dataDirectory: string;

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined = 12_345;
  readonly messages: RuntimeWorkerCommand[] = [];
  killCalls = 0;
  postMessage(message: RuntimeWorkerCommand): void { this.messages.push(message); }
  kill(): boolean { this.killCalls += 1; return true; }
  message(value: unknown): void { this.emit("message", value); }
}

beforeEach(() => {
  vi.useFakeTimers();
  dataDirectory = mkdtempSync(join(tmpdir(), "inertia-mascot-supervisor-"));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  rmSync(dataDirectory, { recursive: true, force: true });
});

it("drops an invalid mascot feed without terminating the runtime and still delivers the next valid one", async () => {
  const child = new FakeUtilityProcess();
  const forceKill = vi.fn(() => true);
  const onMascotStatus = vi.fn();
  const supervisor = new RuntimeSupervisor({
    systemBootId: "test:00000000-0000-4000-8000-000000000001",
    workerOptions: { dataDirectory, defaultWorkspacePath: dataDirectory, enableProviders: false },
    spawn: () => child as never, forceKill, recoverOwnedProcesses: () => true,
    armProcessContainment: () => process.platform === "win32"
      ? { kind: "windows-job-v1", name: `Global\\InertiaRuntime-${"a".repeat(64)}` } : null,
    onMascotStatus,
  });
  supervisor.start();
  child.emit("spawn");
  child.message({ type: "runtime.ready", websocketUrl: readyUrl });
  const waiting = { ...emptyMascotStatus(), phase: "waiting-for-approval" as const, projectId: "p", conversationId: "c", runId: "r", turnId: "t", activeCount: 1 };
  child.message({ type: "runtime.mascot-status", status: emptyMascotStatus(), chats: [waiting], rows: [], focus: null,
    counts: { chats: 1, attention: 0, others: 0 }, request: null });
  child.message({ type: "runtime.mascot-status", status: "broken" });
  await vi.advanceTimersByTimeAsync(0);
  expect(onMascotStatus.mock.calls).toEqual([[null], [null]]);
  expect(child.killCalls + forceKill.mock.calls.length).toBe(0);
  expect(supervisor.snapshot()).toMatchObject({ phase: "ready", lastError: null });
  const valid = { status: { ...emptyMascotStatus(), activeCount: 1 }, chats: [waiting], rows: [], focus: null, counts: { chats: 1, attention: 0, others: 0 }, request: null };
  child.message({ type: "runtime.mascot-status", ...valid });
  expect(onMascotStatus).toHaveBeenLastCalledWith(valid);
});
