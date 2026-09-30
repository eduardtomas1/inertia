import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeSupervisor } from "../../src/main/runtime-supervisor";
import type { RuntimeAgentBrowserBroker } from "../../src/main/runtime-supervisor-types";
import type { RuntimeWorkerCommand } from "../../src/node/runtime-process-protocol";

const readyUrl = `ws://127.0.0.1:41001/runtime/${"a".repeat(43)}`;
const identity = {
  conversationId: "11111111-1111-4111-8111-111111111111",
  runId: "22222222-2222-4222-8222-222222222222",
  turnId: "33333333-3333-4333-8333-333333333333",
};
let dataDirectory: string;

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined = 12_345;
  readonly messages: RuntimeWorkerCommand[] = [];
  killCalls = 0;

  postMessage(message: RuntimeWorkerCommand): void {
    this.messages.push(message);
  }

  kill(): boolean {
    this.killCalls += 1;
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
  dataDirectory = mkdtempSync(join(tmpdir(), "inertia-browser-supervisor-"));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  rmSync(dataDirectory, { recursive: true, force: true });
});

function readySupervisor() {
  const child = new FakeUtilityProcess();
  const forceKill = vi.fn(() => true);
  const agentBrowserBroker: RuntimeAgentBrowserBroker = {
    perform: vi.fn<RuntimeAgentBrowserBroker["perform"]>(async () => ({
      ok: false, code: "not-found", message: "No page",
    })),
  };
  const supervisor = new RuntimeSupervisor({
    systemBootId: "test:00000000-0000-4000-8000-000000000001",
    workerOptions: {
      dataDirectory,
      defaultWorkspacePath: dataDirectory,
      enableProviders: false,
    },
    spawn: () => child as never,
    forceKill,
    recoverOwnedProcesses: () => true,
    agentBrowserBroker,
  });
  supervisor.start();
  child.spawn();
  child.message({ type: "runtime.ready", websocketUrl: readyUrl });
  return { child, forceKill, agentBrowserBroker, supervisor };
}

describe("RuntimeSupervisor agent browser requests", () => {
  it("answers a request whose arguments main rejects as an invalid tool error and keeps the runtime", async () => {
    const { child, forceKill, agentBrowserBroker, supervisor } = readySupervisor();
    const requestId = crypto.randomUUID();
    child.message({
      type: "runtime.agent-browser-request",
      requestId,
      identity,
      command: { action: "type", ref: "e1", text: "x".repeat(4_001), replace: true },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(child.messages.at(-1)).toEqual({
      type: "runtime.agent-browser-result",
      requestId,
      result: { ok: false, code: "invalid", message: expect.any(String) },
    });
    expect(agentBrowserBroker.perform).not.toHaveBeenCalled();
    expect(child.killCalls).toBe(0);
    expect(forceKill).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).toMatchObject({ phase: "ready", generation: 1, lastError: null });
  });

  it("still terminates the runtime for a malformed request envelope", async () => {
    const { child, forceKill, agentBrowserBroker, supervisor } = readySupervisor();
    child.message({
      type: "runtime.agent-browser-request",
      requestId: "not-a-request-id",
      identity,
      command: { action: "snapshot" },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(agentBrowserBroker.perform).not.toHaveBeenCalled();
    expect(child.messages.some((message) => message.type === "runtime.agent-browser-result")).toBe(false);
    expect(child.killCalls + forceKill.mock.calls.length).toBeGreaterThan(0);
    expect(supervisor.snapshot().lastError).toBe("The runtime process sent an invalid lifecycle message.");
  });
});
