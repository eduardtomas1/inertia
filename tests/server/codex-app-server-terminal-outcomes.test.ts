// @inertia-test-suite portable
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawning = vi.hoisted(() => ({ spawn: vi.fn(), terminate: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: spawning.spawn,
}));
vi.mock("../../src/server/codex-app-server", async (original) => {
  const actual = await original<typeof import("../../src/server/codex-app-server")>();
  return {
    ...actual,
    startCodexAppServerRun: (options: Parameters<typeof actual.startCodexAppServerRun>[0]) =>
      actual.startCodexAppServerRun({ ...options, terminateProcessTree: spawning.terminate }),
  };
});

import { startCodexAppServerRun } from "../../src/server/codex/app-server-run";
import { createCodexAppServerHarness } from "../../src/server/provider/codex-app-server-harness";
import { nativeProviderRunInput } from "./model-route-fixture";

function fixture(throughHarness = false) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      const message = JSON.parse(String(chunk)) as { id?: number; method?: string };
      if (message.id !== undefined && message.method) {
        const result = message.method === "thread/start"
          ? { thread: { id: "thread-test" } }
          : message.method === "turn/start" ? { turn: { id: "turn-test" } } : {};
        stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
      }
      callback();
    },
  });
  Object.assign(child, {
    pid: 424242, exitCode: null, signalCode: null,
    stdin, stdout, stderr, stdio: [stdin, stdout, stderr],
  });
  spawning.spawn.mockReturnValue(child);
  let finishCleanup!: (confirmed: boolean) => void;
  const cleanup = new Promise<boolean>((resolve) => { finishCleanup = resolve; });
  const terminateProcessTree = vi.fn(() => cleanup);
  spawning.terminate.mockImplementation(terminateProcessTree);
  const run = throughHarness ? createCodexAppServerHarness().start({
    executable: "/synthetic/codex", environment: {},
    providerNativeToolsAvailable: true,
    input: nativeProviderRunInput({
      providerId: "codex", conversationId: "terminal-outcome-test",
      cwd: "/synthetic", prompt: "Exercise terminal outcomes",
      access: "full", interactionMode: "build",
    }),
  }) : startCodexAppServerRun({
    executable: "/synthetic/codex", cwd: "/synthetic", environment: {},
    prompt: "Exercise terminal outcomes", access: "full", planMode: false,
    rpcTimeoutMs: 50, terminateProcessTree,
  });
  child.emit("spawn");
  return {
    run, terminateProcessTree, finishCleanup,
    serverRequest(method: string, params: Record<string, unknown>) {
      stdout.write(`${JSON.stringify({ id: "review-request", method, params })}\n`);
    },
    unsafeInputRequest(kind: "foreign-turn" | "malformed") {
      stdout.write(`${JSON.stringify({
        id: "unsafe-input", method: "item/tool/requestUserInput",
        params: kind === "malformed" ? {} : {
          threadId: "thread-test", turnId: "foreign-turn", itemId: "unsafe-item",
          questions: [{
            id: "choice", header: "Direction", question: "Which path?",
            options: [{ label: "Safe", description: "Use the bounded path." }],
          }],
        },
      })}\n`);
    },
    malformedFrame() {
      stdout.write("{invalid-json}\n");
    },
    providerError() {
      stdout.write(`${JSON.stringify({
        method: "error",
        params: {
          threadId: "thread-test", turnId: "turn-test", willRetry: false,
          error: { message: "Provider rejected the operation." },
        },
      })}\n`);
    },
    inputRequest(id: string) {
      stdout.write(`${JSON.stringify({
        id, method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-test", turnId: "turn-test", itemId: id,
          questions: [{
            id: "choice", header: "Direction", question: "Which path?",
            options: [{ label: "Safe", description: "Use the bounded path." }],
          }],
        },
      })}\n`);
    },
    malformedDelegation() {
      stdout.write(`${JSON.stringify({
        method: "item/started",
        params: {
          threadId: "thread-test", turnId: "turn-test",
          item: {
            id: "bad-spawn", type: "collabAgentToolCall", tool: "spawnAgent",
            senderThreadId: "thread-test", receiverThreadIds: [null],
          },
        },
      })}\n`);
    },
    terminal(status: string) {
      stdout.write(`${JSON.stringify({
        method: "turn/completed",
        params: {
          threadId: "thread-test",
          turn: { id: "turn-test", status, items: [], error: null },
        },
      })}\n`);
    },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("Codex App Server terminal outcomes", () => {
  it.each([
    ["foreign approval", "item/commandExecution/requestApproval", { threadId: "foreign-thread", command: "npm test" }],
    ["malformed approval", "item/commandExecution/requestApproval", { threadId: "thread-test", command: { invalid: true } }],
    ["unsupported decisions", "item/commandExecution/requestApproval", { threadId: "thread-test", availableDecisions: ["acceptForSession"] }],
    ["foreign time request", "currentTime/read", { threadId: "foreign-thread" }],
    ["malformed time request", "currentTime/read", {}],
    ["foreign elicitation", "mcpServer/elicitation/request", { threadId: "thread-test", turnId: "foreign-turn", serverName: "synthetic", mode: "form" }],
    ["malformed elicitation", "mcpServer/elicitation/request", {}],
  ] as const)("classifies rejected %s as provider failure", async (_label, method, params) => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.serverRequest(method, params);
    app.terminal("interrupted");
    app.finishCleanup(true);
    await expect(app.run.result).resolves.toMatchObject({
      status: "failed", cleanupConfirmed: true,
      failure: { reason: "malformed-protocol" },
    });
    expect(app.terminateProcessTree).toHaveBeenCalledOnce();
  });

  it.each([undefined, "interrupted", "completed"])(
    "fails malformed delegated-agent output even when cleanup races %s",
    async (racingStatus) => {
      const app = fixture();
      await vi.advanceTimersByTimeAsync(0);
      app.malformedDelegation();
      if (racingStatus) app.terminal(racingStatus);
      await vi.advanceTimersByTimeAsync(0);
      expect(app.terminateProcessTree).toHaveBeenCalledOnce();
      let returned = false;
      void app.run.result.then(() => { returned = true; });
      await Promise.resolve();
      expect(returned).toBe(false);
      app.finishCleanup(true);

      await expect(app.run.result).resolves.toMatchObject({
        status: "failed", cleanupConfirmed: true,
        failure: { reason: "malformed-protocol", phase: "running" },
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("preserves explicit cancellation before malformed delegated-agent output", async () => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.run.cancel(false);
    app.malformedDelegation();
    app.terminal("interrupted");
    app.finishCleanup(true);

    await expect(app.run.result).resolves.toMatchObject({
      status: "cancelled", cleanupConfirmed: true,
    });
    expect((await app.run.result).failure).toBeUndefined();
  });

  it("preserves accepted protocol failure before explicit cancellation", async () => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.malformedDelegation();
    app.run.cancel(false);
    app.terminal("completed");
    app.finishCleanup(true);

    await expect(app.run.result).resolves.toMatchObject({
      status: "failed", cleanupConfirmed: true,
      failure: { reason: "malformed-protocol" },
    });
    expect(app.terminateProcessTree).toHaveBeenCalledOnce();
  });

  it("retains the first provider error when malformed output requires stopping", async () => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.providerError();
    app.malformedDelegation();
    app.terminal("interrupted");
    app.finishCleanup(true);

    await expect(app.run.result).resolves.toMatchObject({
      status: "failed", cleanupConfirmed: true,
      failure: { reason: "codex-error" },
    });
  });

  it.each(["duplicate", "overflow"] as const)(
    "fails a %s server request instead of reporting user cancellation",
    async (kind) => {
      const app = fixture();
      await vi.advanceTimersByTimeAsync(0);
      if (kind === "duplicate") {
        app.inputRequest("duplicate");
        app.inputRequest("duplicate");
      } else {
        for (let index = 0; index < 33; index += 1) {
          app.inputRequest(`request-${index}`);
        }
      }
      app.terminal("interrupted");
      app.finishCleanup(true);

      await expect(app.run.result).resolves.toMatchObject({
        status: "failed", cleanupConfirmed: true,
        failure: { reason: "malformed-protocol" },
      });
      expect(app.terminateProcessTree).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("preserves accepted completion before malformed delegated-agent output", async () => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.terminal("completed");
    app.malformedDelegation();
    app.run.cancel(false);
    app.finishCleanup(true);

    await expect(app.run.result).resolves.toMatchObject({
      status: "completed", cleanupConfirmed: true,
    });
    expect((await app.run.result).failure).toBeUndefined();
  });

  it("retains cleanup uncertainty after malformed delegated-agent output", async () => {
    const app = fixture();
    await vi.advanceTimersByTimeAsync(0);
    app.malformedDelegation();
    await vi.advanceTimersByTimeAsync(0);
    app.finishCleanup(false);

    await expect(app.run.result).resolves.toMatchObject({
      status: "failed", cleanupConfirmed: false,
      failure: { reason: "malformed-protocol" },
    });
  });

  it.each(["failed", "completed"] as const)(
    "preserves accepted %s through the public harness when cancellation arrives during cleanup",
    async (status) => {
      const app = fixture(true);
      await vi.advanceTimersByTimeAsync(0);
      if (status === "failed") app.malformedDelegation();
      else app.terminal("completed");
      app.run.cancel(false);
      app.finishCleanup(true);

      await expect(app.run.result).resolves.toMatchObject({
        status, cleanupConfirmed: true,
      });
    },
  );

  it.each([true, false])(
    "preserves public cancellation before a terminal error only when cleanup is confirmed: %s",
    async (cleanupConfirmed) => {
      const app = fixture(true);
      await vi.advanceTimersByTimeAsync(0);
      app.run.cancel(false);
      app.malformedFrame();
      app.finishCleanup(cleanupConfirmed);

      await expect(app.run.result).resolves.toMatchObject({
        status: cleanupConfirmed ? "cancelled" : "failed", cleanupConfirmed,
      });
      if (cleanupConfirmed) expect((await app.run.result).failure).toBeUndefined();
      else expect((await app.run.result).failure).toBeDefined();
    },
  );

  it.each(["foreign-turn", "malformed"] as const)(
    "reports an unsafe %s input request as a protocol failure",
    async (kind) => {
      const app = fixture();
      await vi.advanceTimersByTimeAsync(0);
      app.unsafeInputRequest(kind);
      app.terminal("interrupted");
      app.finishCleanup(true);

      await expect(app.run.result).resolves.toMatchObject({
        status: "failed", cleanupConfirmed: true,
        failure: { reason: "malformed-protocol" },
      });
    },
  );
});
