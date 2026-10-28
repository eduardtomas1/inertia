import { ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const fixture = vi.hoisted(() => ({
  spawn: null as (() => ChildProcessWithoutNullStreams) | null,
  terminate: vi.fn(),
}));

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => fixture.spawn ? fixture.spawn() : actual.spawn(...args),
  };
});

vi.mock("../../src/server/process-lifecycle", async (original) => ({
  ...await original<typeof import("../../src/server/process-lifecycle")>(),
  posixCleanupDiagnosticFor: () => ({
    scope: "child", reason: "owned-stop-unconfirmed", row: "owned-stop-unconfirmed",
    rootStop: null, rootState: null, rootRunningObserved: null, scanStabilized: null,
    groupExited: null, descendantsExited: null, rootExited: null,
    snapshotReads: null, snapshotTimeouts: null, elapsedMs: 0,
  }),
}));

vi.mock("../../src/server/codex-app-server", async (original) => {
  const actual = await original<typeof import("../../src/server/codex-app-server")>();
  return {
    ...actual,
    startCodexAppServerRun: (options: Parameters<typeof actual.startCodexAppServerRun>[0]) =>
      actual.startCodexAppServerRun({ ...options, terminateProcessTree: fixture.terminate }),
  };
});

import { AgentHarnessRegistry, ProviderManager, type AgentHarness } from "../../src/server/providers";
import type { ProviderId } from "../../src/shared/provider";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { createCodexAppServerHarness } from "../../src/server/provider/codex-app-server-harness";
import { createKimiAcpHarness } from "../../src/server/provider/kimi-acp-harness";
import { createOpenCodeSdkHarness } from "../../src/server/provider/opencode-sdk-harness";
import { createAntigravityCliHarness } from "../../src/server/provider/antigravity-cli-harness";
import { providerCleanupIncident } from "../../src/server/provider/run-cleanup-settlement";
import { terminateProcessTreeAndWait } from "../../src/server/process-lifecycle";
import { claudeSuccessResult, claudeSystem, fixtureClaudeQuery } from "../helpers/claude-agent-sdk-protocol";
import { lifecycleServerSource } from "../helpers/opencode-lifecycle-server";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { parseDiagnosticIncident } from "../../src/shared/application-diagnostics";
import { nativeProviderRunInput } from "./model-route-fixture";

const roots: string[] = [];

afterEach(async () => {
  fixture.spawn = null;
  fixture.terminate.mockReset();
  await Promise.all(roots.splice(0).map(removePortableFixture));
});

function inMemoryChild(
  respond: (message: Record<string, unknown>, send: (value: unknown) => void) => void,
  onEnd: (send: (value: unknown) => void) => void = () => undefined,
) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const send = (value: unknown): void => {
    queueMicrotask(() => { if (!stdout.destroyed) stdout.write(`${JSON.stringify(value)}\n`); });
  };
  let pending = "";
  const child = new ChildProcess() as ChildProcessWithoutNullStreams;
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      pending += chunk.toString("utf8");
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.trim().startsWith("{")) respond(JSON.parse(line) as Record<string, unknown>, send);
      }
      callback();
    },
    final(callback) {
      onEnd(send);
      callback();
    },
  });
  const close = (): void => {
    if (child.exitCode !== null) return;
    Object.assign(child, { exitCode: 0 });
    child.emit("exit", 0, null);
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
    child.emit("close", 0, null);
  };
  Object.assign(child, {
    pid: 4_242, stdin, stdout, stderr, stdio: [stdin, stdout, stderr], exitCode: null, signalCode: null,
  });
  fixture.spawn = () => {
    setImmediate(() => child.emit("spawn"));
    return child;
  };
  return { child, close };
}

function failingTermination(close: () => void) {
  return vi.fn(async () => {
    close();
    return false;
  });
}

const drivers: Record<Exclude<ProviderId, "cursor">, (root: string) => {
  harness: AgentHarness;
  command: string;
  sessionId?: string;
}> = {
  codex: () => {
    const { close } = inMemoryChild((message, send) => {
      if (message.id === undefined) return;
      const result = message.method === "thread/start"
        ? { thread: { id: "thread-test" } }
        : message.method === "turn/start" ? { turn: { id: "turn-test" } } : {};
      send({ id: message.id, result });
      if (message.method === "turn/start") {
        setTimeout(() => send({ method: "turn/completed", params: {
          threadId: "thread-test", turn: { id: "turn-test", status: "completed", items: [], error: null },
        } }), 20);
      }
    });
    fixture.terminate.mockImplementation(failingTermination(close));
    return { harness: createCodexAppServerHarness(), command: "/synthetic/codex" };
  },
  claude: (root) => {
    const { child, close } = inMemoryChild(() => undefined);
    fixture.spawn = null;
    return {
      command: process.execPath,
      harness: createClaudeAgentSdkHarness({
        spawnProcess: (() => child) as unknown as typeof import("node:child_process").spawn,
        terminateProcessTree: failingTermination(close),
        createQuery: ({ options }) => {
          options?.spawnClaudeCodeProcess?.({
            command: "/sdk/final/claude", args: [], cwd: root, env: {}, signal: new AbortController().signal,
          });
          return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
            yield claudeSystem("init");
            yield claudeSuccessResult("Done", "completed");
          })());
        },
      }),
    };
  },
  kimi: () => {
    const { close } = inMemoryChild((message, send) => {
      if (message.id === undefined) return;
      if (message.method === "initialize") {
        send({ jsonrpc: "2.0", id: message.id, result: {
          protocolVersion: 1, agentInfo: { name: "Kimi Code CLI", version: "1.0.0" },
          agentCapabilities: { mcpCapabilities: { http: true } }, authMethods: [],
        } });
      } else if (message.method === "session/new") {
        send({ jsonrpc: "2.0", id: message.id, result: {
          sessionId: "cleanup-reason-session",
          modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] },
          configOptions: [],
        } });
      } else if (message.method === "session/prompt") {
        send({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId: "cleanup-reason-session",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } },
        } });
        send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      } else {
        send({ jsonrpc: "2.0", id: message.id, result: {} });
      }
    });
    return { harness: createKimiAcpHarness({ terminateProcessTree: failingTermination(close) }), command: "/synthetic/kimi" };
  },
  opencode: (root) => {
    const command = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(root, "serve", lifecycleServerSource(root, join(root, "capture.json"), "resume"));
    return {
      command,
      sessionId: "opencode-lifecycle-session",
      harness: createOpenCodeSdkHarness({
        terminateProcessTree: async (child, force) => {
          await terminateProcessTreeAndWait(child, force);
          return false;
        },
      }),
    };
  },
  antigravity: () => {
    const { close } = inMemoryChild(() => undefined, (send) => {
      send({ event: "result", result: { status: "SUCCESS", response: "Done", error: "" } });
    });
    return {
      command: "/synthetic/agy",
      harness: createAntigravityCliHarness({
        resultExitGraceMs: 50,
        terminationConfirmMs: 200,
        terminateProcessTree: failingTermination(close),
      }),
    };
  },
};

describe("provider cleanup reason", () => {
  it.each(Object.keys(drivers) as (keyof typeof drivers)[])(
    "carries the %s cleanup failure reason into the provider cleanup incident",
    async (providerId) => {
      const root = portableFixtureRoot(`cleanup reason ${providerId}`);
      roots.push(root);
      const driver = drivers[providerId](root);
      const reported: unknown[] = [];
      const manager = ProviderManager.createForTests(
        {
          commands: { [providerId]: driver.command },
          onRunCleanupUnconfirmed: (identity, cleanupReason) => {
            reported.push(providerCleanupIncident(identity, cleanupReason));
          },
        },
        new AgentHarnessRegistry([driver.harness]),
      );

      const result = await manager.run(nativeProviderRunInput({
        providerId,
        conversationId: `cleanup-reason-${providerId}`,
        cwd: root,
        prompt: "Complete",
        interactionMode: "build",
        access: "supervised",
        ...(driver.sessionId ? { sessionId: driver.sessionId } : {}),
      }));

      expect(result).toMatchObject({ cleanupConfirmed: false, cleanupReason: "owned-stop-unconfirmed" });
      await vi.waitFor(() => expect(reported).toEqual([expect.objectContaining({
        code: "provider.cleanup-unconfirmed",
        metadata: { cleanupReason: "owned-stop-unconfirmed" },
      })]), { timeout: 12_000 });
    },
    20_000,
  );

  it("keeps the incident free of a reason it never observed", () => {
    const incident = providerCleanupIncident({
      providerId: "codex", conversationId: "a", runId: "b", turnId: "c",
    });
    expect(incident.code).toBe("provider.cleanup-unconfirmed");
    expect(incident).not.toHaveProperty("metadata");
  });

  it("accepts only the bounded process cleanup reasons in an incident", () => {
    const base = {
      schemaVersion: 1, id: "10000000-0000-4000-8000-000000000001",
      correlationId: "10000000-0000-4000-8000-000000000002",
      code: "provider.cleanup-unconfirmed", at: "2026-10-28T00:00:00.000Z",
      runtimeGeneration: null, outcome: "unknown", context: {},
    };
    expect(parseDiagnosticIncident({ ...base, metadata: { cleanupReason: "owned-stop-unconfirmed" } })?.metadata)
      .toEqual({ cleanupReason: "owned-stop-unconfirmed" });
    expect(parseDiagnosticIncident({ ...base, metadata: { cleanupReason: "/Users/private/path" } })).toBeNull();
  });
});
