import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeSupervisor } from "../../src/main/runtime-supervisor";
import { runtimeSupervisorDefaults } from "../../src/main/runtime-supervisor-values";
import type { RuntimeWorkerCommand } from "../../src/node/runtime-process-protocol";

const readyUrl = `ws://127.0.0.1:41001/runtime/${"a".repeat(43)}`;
const RENDER_ID = "55555555-5555-4555-8555-555555555555";
const render = {
  conversationId: "22222222-2222-4222-8222-222222222222",
  title: "Weekly chart",
  html: "<p>chart</p>",
};
let dataDirectory: string;

const armProcessContainment = () => process.platform === "win32"
  ? { kind: "windows-job-v1" as const, name: `Global\\InertiaRuntime-${"a".repeat(64)}` }
  : null;

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
    const start = this.messages.findLast((message) => message.type === "runtime.start");
    if ((value as { type?: unknown }).type === "runtime.ready" && start?.type === "runtime.start") {
      // A replacement generation must acknowledge the prior generation's cleanup receipt before it is ready.
      for (const receiptRuntimeGenerationId of start.options.confirmedTerminatedRuntimeGenerationIds ?? []) {
        this.emit("message", {
          type: "runtime.cleanup-receipt-consumed",
          receiptRuntimeGenerationId,
          currentRuntimeGenerationId: start.options.runtimeGenerationId,
        });
      }
    }
    this.emit("message", value);
  }

  exit(code: number): void {
    this.emit("exit", code);
    this.pid = undefined;
  }
}

function readySupervisor(): { supervisor: RuntimeSupervisor; children: FakeUtilityProcess[] } {
  const children: FakeUtilityProcess[] = [];
  const supervisor = new RuntimeSupervisor({
    systemBootId: "test:00000000-0000-4000-8000-000000000001",
    workerOptions: {
      dataDirectory,
      defaultWorkspacePath: dataDirectory,
      enableProviders: false,
    },
    spawn: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child as never;
    },
    recoverOwnedProcesses: () => true,
    armProcessContainment,
  });
  supervisor.start();
  children[0]!.spawn();
  children[0]!.message({ type: "runtime.ready", websocketUrl: readyUrl });
  return { supervisor, children };
}

function lastReadCommand(child: FakeUtilityProcess): Extract<RuntimeWorkerCommand, { type: "runtime.read-html-render" }> {
  const command = child.messages.at(-1);
  if (command?.type !== "runtime.read-html-render") throw new Error("Missing html render read command");
  return command;
}

beforeEach(() => {
  vi.useFakeTimers();
  dataDirectory = mkdtempSync(join(tmpdir(), "inertia-html-render-supervisor-"));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("RuntimeSupervisor visual reply reads", () => {
  it("rejects before the runtime is ready", async () => {
    const supervisor = new RuntimeSupervisor({
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
      workerOptions: { dataDirectory, defaultWorkspacePath: dataDirectory, enableProviders: false },
      spawn: () => new FakeUtilityProcess() as never,
      recoverOwnedProcesses: () => true,
      armProcessContainment,
    });
    await expect(supervisor.readHtmlRender(RENDER_ID)).rejects.toThrow();
  });

  it("correlates a resolved render and a missing render", async () => {
    const { supervisor, children } = readySupervisor();
    const resolved = supervisor.readHtmlRender(RENDER_ID);
    const command = lastReadCommand(children[0]!);
    expect(command).toEqual({ type: "runtime.read-html-render", requestId: expect.any(String), renderId: RENDER_ID });
    children[0]!.message({ type: "runtime.html-render-resolved", requestId: command.requestId, render });
    await expect(resolved).resolves.toEqual(render);

    const missing = supervisor.readHtmlRender(RENDER_ID);
    children[0]!.message({ type: "runtime.html-render-resolved", requestId: lastReadCommand(children[0]!).requestId, render: null });
    await expect(missing).resolves.toBeNull();
  });

  it("rejects when the runtime rejects the read", async () => {
    const { supervisor, children } = readySupervisor();
    const read = supervisor.readHtmlRender(RENDER_ID);
    children[0]!.message({
      type: "runtime.html-render-rejected",
      requestId: lastReadCommand(children[0]!).requestId,
      message: "The visual reply store is unavailable.",
    });
    await expect(read).rejects.toThrow("The visual reply store is unavailable.");
  });

  it("times out and ignores a late answer", async () => {
    const { supervisor, children } = readySupervisor();
    const read = supervisor.readHtmlRender(RENDER_ID);
    const { requestId } = lastReadCommand(children[0]!);
    const settled = expect(read).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(runtimeSupervisorDefaults.requestTimeoutMs);
    await settled;
    children[0]!.message({ type: "runtime.html-render-resolved", requestId, render });
    expect(supervisor.snapshot().phase).toBe("ready");
  });

  it("ignores answers for unknown requests and rejects pending reads when the runtime exits", async () => {
    const { supervisor, children } = readySupervisor();
    const read = supervisor.readHtmlRender(RENDER_ID);
    let settled = false;
    void read.then(() => { settled = true; }, () => { settled = true; });
    children[0]!.message({
      type: "runtime.html-render-resolved",
      requestId: "66666666-6666-4666-8666-666666666666",
      render,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    children[0]!.exit(9);
    await expect(read).rejects.toThrow("stopped");
  });

  it("ignores events from a stale runtime record", async () => {
    const { supervisor, children } = readySupervisor();
    const stale = supervisor.readHtmlRender(RENDER_ID);
    const staleRequest = lastReadCommand(children[0]!).requestId;
    const staleOutcome = expect(stale).rejects.toThrow();
    children[0]!.exit(9);
    await staleOutcome;
    await vi.advanceTimersByTimeAsync(60_000);
    const replacement = children[1];
    if (!replacement) throw new Error("The runtime did not restart");
    replacement.spawn();
    replacement.message({ type: "runtime.ready", websocketUrl: readyUrl });
    expect(supervisor.snapshot().phase).toBe("ready");

    const current = supervisor.readHtmlRender(RENDER_ID);
    const currentRequest = lastReadCommand(replacement).requestId;
    // The exited child can no longer answer, and its old request id is not routed to the new read.
    children[0]!.message({ type: "runtime.html-render-resolved", requestId: currentRequest, render });
    replacement.message({ type: "runtime.html-render-resolved", requestId: staleRequest, render });
    let settled = false;
    void current.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    replacement.message({ type: "runtime.html-render-resolved", requestId: currentRequest, render: null });
    await expect(current).resolves.toBeNull();
  });
});
