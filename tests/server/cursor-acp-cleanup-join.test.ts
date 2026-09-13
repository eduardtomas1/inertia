// @inertia-test-suite portable
import { ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { createCursorAcpHarness } from "../../src/server/provider/cursor-acp-harness";
import type { AgentHarnessRun } from "../../src/server/provider/agent-harness";
import { nativeProviderRunInput } from "./model-route-fixture";

const processFixture = vi.hoisted(() => ({
  child: undefined as ChildProcessWithoutNullStreams | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: () => {
    if (!processFixture.child) throw new Error("Missing in-memory child fixture.");
    return processFixture.child;
  },
}));

vi.mock("../../src/node/runtime-owned-processes", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/node/runtime-owned-processes")>(),
  runtimeOwnedProcessInvocation: (command: string, args: string[]) => ({ command, args }),
  spawnRuntimeOwnedProcess: (spawnChild: () => ChildProcessWithoutNullStreams) => spawnChild(),
  confirmRuntimeOwnedProcessStopped: () => true,
}));

function inMemoryCursor() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const methods: string[] = [];
  let pending = "";
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      pending += chunk.toString("utf8");
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const message = JSON.parse(pending.slice(0, newline)) as { id?: number; method: string };
        pending = pending.slice(newline + 1);
        methods.push(message.method);
        const result = message.method === "initialize"
          ? { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } }
          : message.method === "session/new"
            ? { sessionId: "cursor-cleanup-session", modes: {
                currentModeId: "build", availableModes: [{ id: "build", name: "Build" }],
              }, configOptions: [] }
            : message.method === "session/prompt"
              ? { stopReason: "end_turn" }
              : undefined;
        if (result) queueMicrotask(() => stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`,
        ));
      }
      callback();
    },
  });
  // Construct stream-backed handles without spawning a native process.
  const child = Object.assign(new ChildProcess(), {
    stdin, stdout, stderr, exitCode: null, signalCode: null,
  }) as ChildProcessWithoutNullStreams;
  return { child, methods, dispose: () => {
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
  } };
}

describe("Cursor MCP and process cleanup join", () => {
  it.each([
    { cancelDuringPreparation: false, terminationConfirmed: true },
    { cancelDuringPreparation: true, terminationConfirmed: true },
    { cancelDuringPreparation: false, terminationConfirmed: false },
  ])(
    "joins MCP failure and termination (early cancel: $cancelDuringPreparation, confirmed: $terminationConfirmed)",
    async ({ cancelDuringPreparation, terminationConfirmed }) => {
      const fixture = inMemoryCursor();
      processFixture.child = fixture.child;
      let releaseTermination!: () => void;
      const terminationGate = new Promise<void>((resolve) => { releaseTermination = resolve; });
      let markTerminationStarted!: () => void;
      const terminationStarted = new Promise<void>((resolve) => { markTerminationStarted = resolve; });
      let terminationCompleted = false;
      const terminate = vi.fn(async () => {
        markTerminationStarted();
        await terminationGate;
        terminationCompleted = true;
        return terminationConfirmed;
      });
      let closePromise: Promise<void> | undefined;
      const close = vi.fn(() => {
        closePromise ??= Promise.reject(new Error("Injected MCP close failure."));
        return closePromise;
      });
      const statuses: string[] = [];
      let run!: AgentHarnessRun;
      try {
        run = createCursorAcpHarness({
          terminateProcessTree: terminate,
          createHostMcpSession: () => ({
            start: async () => ({ url: "http://127.0.0.1:9/mcp", bearerToken: "fixture-only" }),
            close,
          }),
        }).start({
          input: nativeProviderRunInput({
            providerId: "cursor", conversationId: "cursor-cleanup-join", cwd: process.cwd(),
            prompt: "Complete the fixture.", interactionMode: "build", access: "supervised",
          }),
          executable: "in-memory-cursor", environment: {}, providerNativeToolsAvailable: false,
          hostTools: { definitions: [], invoke: async () => ({ success: true, text: "{}" }) },
          callbacks: { onEvent: (event) => {
            if (event.type === "session" && cancelDuringPreparation) run.cancel(false);
            if (event.type === "status") statuses.push(event.status);
          } },
        });
        let settled = false;
        void run.result.then(() => { settled = true; });
        await terminationStarted;
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(close).toHaveBeenCalled();
        expect(terminate).toHaveBeenCalledExactlyOnceWith(fixture.child, true);
        expect(terminationCompleted).toBe(false);
        expect(settled).toBe(false);
        expect(statuses).not.toContain("failed");
        expect(fixture.methods.includes("session/prompt")).toBe(!cancelDuringPreparation);

        releaseTermination();
        await expect(run.result).resolves.toMatchObject({
          status: "failed", cleanupConfirmed: false,
          failure: {
            reason: "provider-error", phase: "cleanup",
            terminalEvent: terminationConfirmed ? "host-tools/cleanup" : "process-tree/cleanup",
          },
          terminalReason: { outcome: "failed", reason: "provider-error" },
        });
        expect(terminationCompleted).toBe(true);
        expect(statuses.at(-1)).toBe("failed");
      } finally {
        releaseTermination();
        await run?.result;
        fixture.dispose();
        processFixture.child = undefined;
      }
    },
  );
});
