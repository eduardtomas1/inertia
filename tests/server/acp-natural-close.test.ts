import { ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentHarness } from "../../src/server/provider/agent-harness";
import { createCursorAcpHarness } from "../../src/server/provider/cursor-acp-harness";
import { createKimiAcpHarness } from "../../src/server/provider/kimi-acp-harness";
import { nativeProviderRunInput } from "./model-route-fixture";

const fixture = vi.hoisted(() => ({
  child: undefined as ChildProcessWithoutNullStreams | undefined,
  platform: "darwin" as "darwin" | "linux" | null,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: () => {
    if (!fixture.child) throw new Error("Missing in-memory child fixture.");
    return fixture.child;
  },
}));

vi.mock("../../src/node/runtime-owned-processes", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/node/runtime-owned-processes")>(),
  activeRuntimeOwnedProcessPlatform: () => fixture.platform,
  runtimeOwnedProcessInvocation: (command: string, args: string[]) => ({ command, args }),
  spawnRuntimeOwnedProcess: (spawnChild: () => ChildProcessWithoutNullStreams) => spawnChild(),
  confirmRuntimeOwnedProcessStopped: () => true,
}));

type Provider = "kimi" | "cursor";

function inMemoryAgent(provider: Provider, exitsOnEof: boolean, events: string[]) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let pending = "";
  const send = (message: unknown): void => {
    queueMicrotask(() => stdout.write(`${JSON.stringify(message)}\n`));
  };
  const child = new ChildProcess() as ChildProcessWithoutNullStreams;
  const close = (): void => {
    if (child.exitCode !== null) return;
    Object.assign(child, { exitCode: 0 });
    child.emit("exit", 0, null);
    stdout.end();
    stderr.end();
    events.push("close");
    child.emit("close", 0, null);
  };
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      pending += chunk.toString("utf8");
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const message = JSON.parse(pending.slice(0, newline)) as {
          id?: number; method: string; params?: { sessionId?: string };
        };
        pending = pending.slice(newline + 1);
        if (message.id === undefined) continue;
        if (message.method === "initialize") {
          send({ jsonrpc: "2.0", id: message.id, result: {
            protocolVersion: 1,
            agentInfo: { name: provider === "kimi" ? "Kimi Code CLI" : "Cursor Agent", version: "1.0.0" },
            agentCapabilities: { mcpCapabilities: { http: true } },
            authMethods: [],
          } });
        } else if (message.method === "session/new") {
          send({ jsonrpc: "2.0", id: message.id, result: {
            sessionId: "natural-close-session",
            modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] },
            configOptions: [],
          } });
        } else if (message.method === "session/prompt") {
          send({ jsonrpc: "2.0", method: "session/update", params: {
            sessionId: "natural-close-session",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } },
          } });
          send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        } else {
          send({ jsonrpc: "2.0", id: message.id, result: {} });
        }
      }
      callback();
    },
    final(callback) {
      events.push("eof");
      if (exitsOnEof) setTimeout(close, 10);
      callback();
    },
  });
  Object.assign(child, {
    pid: 4_242, stdin, stdout, stderr, stdio: [stdin, stdout, stderr], exitCode: null, signalCode: null,
  });
  return { child, close };
}

function run(provider: Provider, exitsOnEof: boolean) {
  const events: string[] = [];
  const agent = inMemoryAgent(provider, exitsOnEof, events);
  fixture.child = agent.child;
  const terminateProcessTree = vi.fn(async () => {
    events.push("terminate");
    agent.close();
    return true;
  });
  const harness: AgentHarness = provider === "kimi"
    ? createKimiAcpHarness({ terminateProcessTree })
    : createCursorAcpHarness({ terminateProcessTree });
  const started = harness.start({
    input: nativeProviderRunInput({
      providerId: provider, conversationId: `${provider}-natural-close`, cwd: process.cwd(),
      prompt: "Complete the fixture.", interactionMode: "build", access: "supervised",
    }),
    executable: `in-memory-${provider}`, environment: {}, providerNativeToolsAvailable: false,
    callbacks: {},
  });
  return { events, result: started.result };
}

afterEach(() => {
  fixture.child = undefined;
  fixture.platform = "darwin";
});

describe.each(["kimi", "cursor"] as const)("%s ACP natural close", (provider) => {
  it("ends a completed macOS turn through EOF before stopping its guardian", async () => {
    const { events, result } = run(provider, true);

    await expect(result).resolves.toMatchObject({ status: "completed", cleanupConfirmed: true });
    expect(events).toEqual(["eof", "close", "terminate"]);
  });

  it("stops a macOS agent that ignores EOF after the bounded window", async () => {
    const startedAt = Date.now();
    const { events, result } = run(provider, false);

    await expect(result).resolves.toMatchObject({ status: "completed", cleanupConfirmed: true });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_900);
    expect(events).toEqual(["eof", "terminate", "close"]);
  });

  it("keeps the immediate strict stop where no macOS guardian owns the agent", async () => {
    fixture.platform = "linux";
    const { events, result } = run(provider, true);

    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(events[0]).toBe("terminate");
  });
});
