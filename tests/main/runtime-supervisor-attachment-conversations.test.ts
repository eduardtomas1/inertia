import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeSupervisor } from "../../src/main/runtime-supervisor";
import { runtimeSupervisorDefaults } from "../../src/main/runtime-supervisor-values";
import type { RuntimeWorkerCommand } from "../../src/node/runtime-process-protocol";

const readyUrl = `ws://127.0.0.1:41001/runtime/${"a".repeat(43)}`;
const ATTACHMENT_ID = "55555555-5555-4555-8555-555555555555";
const OWNER = "22222222-2222-4222-8222-222222222222";
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

function lastQuery(child: FakeUtilityProcess): Extract<RuntimeWorkerCommand, { type: "runtime.attachment-conversations" }> {
  const command = child.messages.at(-1);
  if (command?.type !== "runtime.attachment-conversations") throw new Error("Missing attachment owner query");
  return command;
}

beforeEach(() => {
  vi.useFakeTimers();
  dataDirectory = mkdtempSync(join(tmpdir(), "inertia-attachment-owner-supervisor-"));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("RuntimeSupervisor attachment owner reads", () => {
  it("rejects before the runtime is ready", async () => {
    const supervisor = new RuntimeSupervisor({
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
      workerOptions: { dataDirectory, defaultWorkspacePath: dataDirectory, enableProviders: false },
      spawn: () => new FakeUtilityProcess() as never,
      recoverOwnedProcesses: () => true,
      armProcessContainment,
    });
    await expect(supervisor.attachmentConversations(ATTACHMENT_ID)).rejects.toThrow();
  });

  it("correlates owners and rejections, and does not route a project path answer to it", async () => {
    const { supervisor, children } = readySupervisor();
    const owners = supervisor.attachmentConversations(ATTACHMENT_ID);
    const command = lastQuery(children[0]!);
    expect(command).toEqual({ type: "runtime.attachment-conversations", requestId: expect.any(String), attachmentId: ATTACHMENT_ID });
    children[0]!.message({ type: "runtime.project-path-resolved", requestId: command.requestId, path: dataDirectory });
    let settled = false;
    void owners.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    children[0]!.message({ type: "runtime.attachment-conversations-resolved", requestId: command.requestId, conversationIds: [OWNER] });
    await expect(owners).resolves.toEqual([OWNER]);

    const refused = supervisor.attachmentConversations(ATTACHMENT_ID);
    children[0]!.message({
      type: "runtime.attachment-conversations-rejected",
      requestId: lastQuery(children[0]!).requestId,
      message: "The attachment's chats could not be read.",
    });
    await expect(refused).rejects.toThrow("The attachment's chats could not be read.");
  });

  it("times out, and rejects pending reads when the runtime exits", async () => {
    const { supervisor, children } = readySupervisor();
    const late = supervisor.attachmentConversations(ATTACHMENT_ID);
    const { requestId } = lastQuery(children[0]!);
    const timedOut = expect(late).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(runtimeSupervisorDefaults.requestTimeoutMs);
    await timedOut;
    children[0]!.message({ type: "runtime.attachment-conversations-resolved", requestId, conversationIds: [OWNER] });
    expect(supervisor.snapshot().phase).toBe("ready");

    const pending = supervisor.attachmentConversations(ATTACHMENT_ID);
    children[0]!.exit(9);
    await expect(pending).rejects.toThrow("stopped");
  });
});
