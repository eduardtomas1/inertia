// @inertia-test-suite portable
import { ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createCursorAcpHarness } from "../../src/server/provider/cursor-acp-harness";
import { createKimiAcpHarness, permissionDisplayIsSafe } from "../../src/server/provider/kimi-acp-harness";
import { cursorPermissionDisplayIsSafe } from "../../src/server/provider/cursor-acp-permissions";
import { acpPermissionDetail } from "../../src/server/provider/acp-permission-detail";
import { cursorRuntimeFailure } from "../../src/server/provider/cursor-acp-failures";
import { nativeProviderRunInput } from "./model-route-fixture";

const fixtureState = vi.hoisted(() => ({ child: undefined as ChildProcessWithoutNullStreams | undefined }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: () => fixtureState.child!,
}));
vi.mock("../../src/node/runtime-owned-processes", async (original) => ({
  ...await original<typeof import("../../src/node/runtime-owned-processes")>(),
  runtimeOwnedProcessInvocation: (command: string, args: string[]) => ({ command, args }),
  spawnRuntimeOwnedProcess: (spawn: () => ChildProcessWithoutNullStreams) => spawn(),
  confirmRuntimeOwnedProcessStopped: () => true,
}));

const toolCall = {
  toolCallId: "edit-1", title: "Edit file", kind: "edit" as const, status: "pending" as const,
  content: [{ type: "diff" as const, path: "target.txt", oldText: "before", newText: "after" }],
  locations: [{ path: "target.txt", line: 1 }],
};

describe("ACP approval hardening", () => {
  it("includes the patch and target even without raw input", () => {
    expect(JSON.parse(acpPermissionDetail({ toolCall }, "fallback"))).toEqual({
      content: toolCall.content, locations: toolCall.locations,
    });
    for (const validate of [cursorPermissionDisplayIsSafe, permissionDisplayIsSafe]) {
      expect(validate({ toolCall })).toBe(true);
      expect(validate({ toolCall: { ...toolCall, locations: [{ path: "safe\u202Etxt.exe" }] } })).toBe(false);
      expect(validate({ toolCall: { ...toolCall, content: [{ type: "diff", path: "target.txt", oldText: "before", newText: "hidden\u202Etext" }] } })).toBe(false);
    }
  });

  it("bounds and sanitizes Cursor failure summaries and technical detail", () => {
    const child = { signalCode: null, exitCode: null } as ChildProcessWithoutNullStreams;
    const result = cursorRuntimeFailure(
      `Failure at /private/workspace/secret.txt api_key=synthetic-test-credential ${"x".repeat(10_000)}`,
      child, "turn", "session/prompt", "/private/workspace",
    );
    expect(result.message.length).toBeLessThanOrEqual(512);
    expect(JSON.stringify(result)).not.toContain("/private/workspace");
    expect(JSON.stringify(result)).not.toContain("synthetic-test-credential");
    expect(result.reason).toBe("provider-error");
  });

  it.each([
    { providerId: "cursor" as const, failure: false },
    { providerId: "kimi" as const, failure: false },
    { providerId: "cursor" as const, failure: true },
    { providerId: "kimi" as const, failure: true },
  ])("$providerId protects plan permissions and split stderr (failure: $failure)", async ({ providerId, failure }) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let promptId: number | undefined;
    let answer: unknown;
    let pending = "";
    const send = (value: unknown) => queueMicrotask(() => stdout.write(`${JSON.stringify(value)}\n`));
    const stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
      pending += chunk.toString("utf8");
      while (pending.includes("\n")) {
        const end = pending.indexOf("\n");
        const message = JSON.parse(pending.slice(0, end)) as { id?: number; method?: string; result?: unknown };
        pending = pending.slice(end + 1);
        const result = message.method === "initialize"
          ? { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: providerId === "kimi" ? "Kimi Code" : "Cursor", version: "test" } }
          : message.method === "session/new"
            ? { sessionId: "approval-session", modes: { currentModeId: "plan", availableModes: [{ id: "plan", name: "Plan" }, { id: "build", name: "Build" }] }, configOptions: [] }
            : undefined;
        if (result) send({ jsonrpc: "2.0", id: message.id, result });
        if (message.method === "session/prompt") {
          promptId = message.id;
          if (failure) {
            const diagnostic = Buffer.from("日本 synthetic-secret-value-12345 tail");
            stderr.write(diagnostic.subarray(0, 2));
            stderr.write(diagnostic.subarray(2, 18));
            stderr.write(diagnostic.subarray(18));
            send({ jsonrpc: "2.0", id: promptId, error: { code: -32000, message: "Synthetic transport failure" } });
            continue;
          }
          send({ jsonrpc: "2.0", id: 100, method: "session/request_permission", params: {
            sessionId: "approval-session", toolCall,
            options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
          } });
        }
        if (message.id === 100) {
          answer = message.result;
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "approval-session", update: {
            sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Plan complete." },
          } } });
          send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
        }
      }
      callback();
    } });
    const child = Object.assign(new ChildProcess(), { stdin, stdout, stderr, exitCode: null, signalCode: null }) as ChildProcessWithoutNullStreams;
    fixtureState.child = child;
    const options = { terminateProcessTree: async () => true };
    const harness = providerId === "cursor" ? createCursorAcpHarness(options) : createKimiAcpHarness(options);
    const approvals = vi.fn();
    try {
      const run = harness.start({
        input: nativeProviderRunInput({ providerId, conversationId: "approval-test", cwd: process.cwd(), prompt: "Plan", interactionMode: "plan", access: "full" }),
        executable: "in-memory", environment: { TEST_API_KEY: "synthetic-secret-value-12345" }, providerNativeToolsAvailable: false,
        callbacks: { onEvent: (event) => { if (event.type === "extension" && event.event.type === "approval") approvals(event); } },
      });
      const result = await run.result;
      expect(result.cleanupConfirmed).toBe(true);
      if (failure) {
        expect(result.status).toBe("failed");
        expect(JSON.stringify(result)).not.toContain("synthetic-secret-value-12345");
        expect(JSON.stringify(result)).not.toContain("�");
        expect(result.failure?.technicalDetail).toContain("日本");
      } else {
        expect(result.error).toBeUndefined();
        expect(result.status).toBe("completed");
        expect(answer).toEqual({ outcome: { outcome: "cancelled" } });
      }
      expect(approvals).not.toHaveBeenCalled();
    } finally {
      stdin.destroy(); stdout.destroy(); stderr.destroy();
    }
  });
});
