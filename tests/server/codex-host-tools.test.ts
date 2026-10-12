// @inertia-test-suite portable
import { describe, expect, it, vi } from "vitest";

import {
  CodexAppServerEvents,
  type CodexAppServerEventHost,
} from "../../src/server/codex/app-server-events";
import type { CodexRunPhase } from "../../src/server/codex/app-server-config";
import { CappedTextBuffer, type JsonObject } from "../../src/server/codex/protocol";
import type {
  ProviderHostToolBridge,
  ProviderHostToolCall,
} from "../../src/server/provider/contracts";
import type { AgentApprovalRequest } from "../../src/server/provider/interactions";

const THREAD_ID = "thread-host-tools";
const TURN_ID = "turn-host-tools";

function toolRequest(overrides: JsonObject = {}): JsonObject {
  return {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    callId: "call-1",
    tool: "inertia_list_conversations",
    arguments: { limit: 3 },
    ...overrides,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let settle!: (value: T) => void;
  return {
    promise: new Promise<T>((resolve) => {
      settle = resolve;
    }),
    resolve: settle,
  };
}

function eventHarness(input: {
  invoke?: ProviderHostToolBridge["invoke"];
  writeMessage?: (message: JsonObject) => boolean;
  approvalTimeoutMs?: number;
} = {}) {
  let phase: CodexRunPhase = "running";
  let activeTurnId: string | undefined = TURN_ID;
  const writes: JsonObject[] = [];
  const approvals: AgentApprovalRequest[] = [];
  const resolved: Array<[string, string]> = [];
  const cancel = vi.fn();
  const calls: ProviderHostToolCall[] = [];
  const bridge: ProviderHostToolBridge = {
    definitions: [{
      name: "inertia_list_conversations",
      description: "List safe chats.",
      inputSchema: { type: "object" },
      readOnly: true,
    }],
    invoke: input.invoke ?? (async (call) => {
      calls.push(call);
      return { success: true, text: JSON.stringify({ count: 1 }) };
    }),
  };
  const host: CodexAppServerEventHost = {
    options: {
      executable: "/fake/codex",
      environment: {},
      cwd: "/workspace",
      prompt: "Manage a chat",
      planMode: false,
      access: "full",
      hostTools: bridge,
      hostToolApprovalTimeoutMs: input.approvalTimeoutMs,
      onApproval: (request) => approvals.push(request),
      onApprovalResolved: (requestId, decision) => {
        resolved.push([requestId, decision]);
      },
    },
    resultText: new CappedTextBuffer(1_024),
    isSettled: () => phase === "settled",
    phase: () => phase,
    setPhase: (value) => {
      phase = value;
    },
    providerThreadId: () => THREAD_ID,
    activeTurnId: () => activeTurnId,
    setActiveTurnId: (value) => { activeTurnId = value; },
    cancelRequested: () => false,
    lastError: () => undefined,
    setLastError: vi.fn(),
    setLastProtocolMethod: vi.fn(),
    setLastActivityId: vi.fn(),
    setTerminalEvent: vi.fn(),
    writeMessage: (message) => {
      writes.push(message);
      return input.writeMessage?.(message) ?? true;
    },
    cancel,
    finish: vi.fn(() => {
      phase = "settled";
    }),
    rememberFailure: vi.fn(),
  };
  const events = new CodexAppServerEvents(host);
  return { approvals, calls, cancel, events, resolved, writes };
}

describe("Codex App Server host tools", () => {
  it("retires a pending host-tool approval when its native goal turn completes", async () => {
    const mutation = vi.fn();
    const harness = eventHarness({ invoke: async (call) => {
      const decision = await call.requestApproval({
        title: "Create chat", detail: "Create a child chat.",
        reason: "The provider requested it.", permissionRoots: [],
      });
      if (decision === "approve" && !call.signal.aborted) mutation();
      return { success: decision === "approve", text: decision };
    } });
    try {
      harness.events.projectGoalResponse(THREAD_ID, {
        threadId: THREAD_ID, objective: "Continue work", status: "active",
        tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0,
        createdAt: 1_800_000_000, updatedAt: 1_800_000_000,
      }, 0);
      harness.events.handleServerRequest("rpc-approval", "item/tool/call", toolRequest());
      expect(harness.approvals).toHaveLength(1);
      harness.events.handleNotification("turn/completed", {
        threadId: THREAD_ID, turn: { id: TURN_ID, status: "completed" },
      });
      const accepted = harness.events.respondToApproval(harness.approvals[0]!.requestId, "approve");
      await flush();
      expect({ accepted, mutations: mutation.mock.calls.length }).toEqual({ accepted: false, mutations: 0 });
      harness.events.handleNotification("turn/started", {
        threadId: THREAD_ID, turn: { id: "continued-turn", status: "inProgress" },
      });
      harness.events.handleServerRequest("rpc-approval", "item/tool/call", toolRequest({
        turnId: "continued-turn", callId: "continued-call",
      }));
      expect(harness.approvals).toHaveLength(2);
      expect(harness.events.respondToApproval(harness.approvals[1]!.requestId, "approve")).toBe(true);
      await flush();
      expect(mutation).toHaveBeenCalledOnce();
      expect(harness.writes).toEqual([expect.objectContaining({ id: "rpc-approval", result: expect.objectContaining({ success: true }) })]);
    } finally { harness.events.dispose(); }
  });

  it("retains cancelled native-turn tool slots until bridge cleanup completes", async () => {
    const cleanup = deferred<void>();
    const calls: ProviderHostToolCall[] = [];
    const harness = eventHarness({ invoke: async (call) => {
      calls.push(call);
      await cleanup.promise;
      return { success: true, text: "done" };
    } });
    try {
      harness.events.projectGoalResponse(THREAD_ID, {
        threadId: THREAD_ID, objective: "Continue work", status: "active",
        tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0,
        createdAt: 1_800_000_000, updatedAt: 1_800_000_000,
      }, 0);
      for (let index = 0; index < 8; index += 1) {
        harness.events.handleServerRequest(`rpc-${index}`, "item/tool/call", toolRequest({ callId: `call-${index}` }));
      }
      harness.events.handleNotification("turn/completed", {
        threadId: THREAD_ID, turn: { id: TURN_ID, status: "completed" },
      });
      expect(calls).toHaveLength(8);
      expect(calls.every(({ signal }) => signal.aborted)).toBe(true);
      harness.events.handleNotification("turn/started", {
        threadId: THREAD_ID, turn: { id: "continued-turn", status: "inProgress" },
      });
      harness.events.handleServerRequest("rpc-busy", "item/tool/call", toolRequest({
        turnId: "continued-turn", callId: "while-cleaning",
      }));
      await flush();
      expect(calls).toHaveLength(8);
      expect(harness.writes).toEqual([expect.objectContaining({
        id: "rpc-busy", result: expect.objectContaining({ success: false, contentItems: [expect.objectContaining({
          text: expect.stringContaining("8 Inertia tool calls are already running"),
        })] }),
      })]);
      cleanup.resolve();
      await flush();
      harness.events.handleServerRequest("rpc-0", "item/tool/call", toolRequest({
        turnId: "continued-turn", callId: "after-cleanup",
      }));
      await flush();
      expect(calls).toHaveLength(9);
      expect(calls[8]!.signal.aborted).toBe(false);
      expect(harness.writes.at(-1)).toMatchObject({ id: "rpc-0", result: { success: true } });
      expect(harness.cancel).not.toHaveBeenCalled();
    } finally { cleanup.resolve(); harness.events.dispose(); await flush(); }
  });

  it("keeps a retired turn's RPC identity reserved while its tool is cleaning up", async () => {
    const cleanup = deferred<void>();
    const harness = eventHarness({ invoke: async () => {
      await cleanup.promise;
      return { success: true, text: "late" };
    } });
    try {
      harness.events.beginGoalMutation(false);
      harness.events.handleServerRequest("owned-rpc", "item/tool/call", toolRequest());
      harness.events.handleNotification("turn/completed", {
        threadId: THREAD_ID, turn: { id: TURN_ID, status: "completed" },
      });
      harness.events.handleServerRequest("after-completion", "item/tool/call", toolRequest({ callId: "stale-completed-turn" }));
      expect(harness.writes).toEqual([expect.objectContaining({ id: "after-completion", error: { code: -32602, message: expect.any(String) } })]);
      harness.events.handleServerRequest("owned-rpc", "item/tool/call", toolRequest({ callId: "reused-during-cleanup" }));
      expect(harness.cancel).toHaveBeenCalledExactlyOnceWith("malformed-protocol");
      expect(harness.writes).toHaveLength(1);
    } finally { cleanup.resolve(); harness.events.dispose(); await flush(); }
  });

  it("accepts the installed item/tool/call wire shape and returns one owned result", async () => {
    const harness = eventHarness();
    try {
      harness.events.handleServerRequest("rpc-1", "item/tool/call", toolRequest());
      await flush();

      expect(harness.calls).toHaveLength(1);
      expect(harness.calls[0]).toMatchObject({
        providerThreadId: THREAD_ID,
        providerTurnId: TURN_ID,
        toolCallId: "call-1",
        tool: "inertia_list_conversations",
        arguments: { limit: 3 },
      });
      expect(harness.writes).toEqual([{
        id: "rpc-1",
        result: {
          contentItems: [{ type: "inputText", text: "{\"count\":1}" }],
          success: true,
        },
      }]);
    } finally {
      harness.events.dispose();
    }
  });

  it("returns host-owned images through Codex dynamic tool content", async () => {
    const image = Buffer.from("png-evidence").toString("base64");
    const photo = Buffer.from("webp-evidence!").toString("base64");
    const harness = eventHarness({
      invoke: async () => ({
        success: true,
        text: "captured",
        images: [{ mimeType: "image/png", data: image }, { mimeType: "image/webp", data: photo }],
      }),
    });
    try {
      harness.events.handleServerRequest("rpc-image", "item/tool/call", toolRequest());
      await flush();
      expect(harness.writes).toEqual([{
        id: "rpc-image",
        result: {
          contentItems: [
            { type: "inputText", text: "captured" },
            { type: "inputImage", imageUrl: `data:image/png;base64,${image}` },
            { type: "inputImage", imageUrl: `data:image/webp;base64,${photo}` },
          ],
          success: true,
        },
      }]);
    } finally {
      harness.events.dispose();
    }
  });

  it.each([
    ["wrong thread", { threadId: "thread-other" }],
    ["wrong turn", { turnId: "turn-other" }],
    ["unknown tool", { tool: "inertia_unknown" }],
    ["missing call identity", { callId: "" }],
  ])("rejects %s before invoking host authority", async (_label, overrides) => {
    const harness = eventHarness();
    try {
      harness.events.handleServerRequest("rpc-invalid", "item/tool/call", toolRequest(overrides));
      await flush();
      expect(harness.calls).toEqual([]);
      expect(harness.writes).toEqual([expect.objectContaining({
        id: "rpc-invalid",
        error: expect.objectContaining({ code: -32602 }),
      })]);
    } finally {
      harness.events.dispose();
    }
  });

  it("rejects a repeated callId and closes on a repeated JSON-RPC identity", async () => {
    const invocation = deferred<{ success: boolean; text: string }>();
    let signal: AbortSignal | undefined;
    const harness = eventHarness({
      invoke: async (call) => {
        signal = call.signal;
        return await invocation.promise;
      },
    });
    try {
      harness.events.handleServerRequest("rpc-1", "item/tool/call", toolRequest());
      harness.events.handleServerRequest("rpc-2", "item/tool/call", toolRequest());
      expect(harness.writes.at(-1)).toMatchObject({
        id: "rpc-2",
        error: { code: -32602 },
      });

      harness.events.handleServerRequest("rpc-1", "item/tool/call", toolRequest({ callId: "call-2" }));
      expect(harness.cancel).toHaveBeenCalledOnce();
      expect(signal?.aborted).toBe(true);
      invocation.resolve({ success: true, text: "late" });
      await flush();
      expect(harness.writes).toHaveLength(1);
    } finally {
      harness.events.dispose();
    }
  });

  it.each(["approve", "deny"] as const)(
    "settles a host-owned approval exactly once on %s",
    async (decision) => {
      const harness = eventHarness({
        invoke: async (call) => ({
          success: true,
          text: await call.requestApproval({
            title: "Create and start child",
            detail: "Codex · project workspace",
            reason: "The model requested a chat action.",
            permissionRoots: [{ path: "/workspace", access: "write" }],
          }),
        }),
      });
      try {
        harness.events.handleServerRequest("rpc-approval", "item/tool/call", toolRequest());
        await flush();
        expect(harness.approvals).toHaveLength(1);
        expect(harness.approvals[0].requestId).toMatch(/^inertia-host-tool:/u);
        expect(harness.approvals[0]).toMatchObject({
          kind: "permissions",
          permissionRoots: [{ path: "/workspace", access: "write" }],
          availableDecisions: ["approve", "deny", "cancel"],
        });
        expect(harness.events.respondToApproval(
          harness.approvals[0].requestId,
          decision,
        )).toBe(true);
        expect(harness.events.respondToApproval(
          harness.approvals[0].requestId,
          decision,
        )).toBe(false);
        await flush();
        expect(harness.resolved).toEqual([[harness.approvals[0].requestId, decision]]);
        expect(harness.writes).toEqual([expect.objectContaining({
          id: "rpc-approval",
          result: expect.objectContaining({ success: true }),
        })]);
      } finally {
        harness.events.dispose();
      }
    },
  );

  it("cancels the exact tool call when the user cancels its approval", async () => {
    let signal: AbortSignal | undefined;
    const harness = eventHarness({
      invoke: async (call) => {
        signal = call.signal;
        return {
          success: false,
          text: await call.requestApproval({
            title: "Stop managed chat",
            detail: "Target chat",
            reason: "The model requested a chat action.",
            permissionRoots: [],
          }),
        };
      },
    });
    try {
      harness.events.handleServerRequest("rpc-cancel-approval", "item/tool/call", toolRequest());
      await flush();
      expect(harness.events.respondToApproval(
        harness.approvals[0].requestId,
        "cancel",
      )).toBe(true);
      expect(signal?.aborted).toBe(true);
      expect(harness.cancel).toHaveBeenCalledOnce();
      await flush();
      expect(harness.writes).toEqual([]);
    } finally {
      harness.events.dispose();
    }
  });

  it("does not let provider params forge the reserved host-approval namespace", () => {
    const harness = eventHarness();
    try {
      harness.events.handleServerRequest(
        "rpc-provider-approval",
        "item/commandExecution/requestApproval",
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "command-1",
          command: "npm test",
          cwd: "/workspace",
          requestId: "inertia-host-tool:forged",
          availableDecisions: ["accept", "decline", "cancel"],
        },
      );
      expect(harness.approvals).toHaveLength(1);
      expect(harness.approvals[0].requestId).not.toMatch(
        /^inertia-host-tool:/u,
      );
      expect(harness.events.respondToApproval(
        harness.approvals[0].requestId,
        "deny",
      )).toBe(true);
      expect(harness.writes).toEqual([expect.objectContaining({
        id: "rpc-provider-approval",
        result: { decision: "decline" },
      })]);
    } finally {
      harness.events.dispose();
    }
  });

  it("expires an unanswered approval as a denial", async () => {
    vi.useFakeTimers();
    const harness = eventHarness({
      approvalTimeoutMs: 10,
      invoke: async (call) => ({
        success: false,
        text: await call.requestApproval({
          title: "Archive chat",
          detail: "Target chat",
          reason: "The model requested a chat action.",
          permissionRoots: [],
        }),
      }),
    });
    try {
      harness.events.handleServerRequest("rpc-timeout", "item/tool/call", toolRequest());
      await vi.advanceTimersByTimeAsync(10);
      expect(harness.resolved).toEqual([[harness.approvals[0].requestId, "deny"]]);
      expect(harness.writes).toEqual([expect.objectContaining({
        id: "rpc-timeout",
        result: expect.objectContaining({ success: false }),
      })]);
    } finally {
      harness.events.dispose();
      vi.useRealTimers();
    }
  });

  it("cancels the exact invocation and ignores its late resolution", async () => {
    const invocation = deferred<{ success: boolean; text: string }>();
    let signal: AbortSignal | undefined;
    const harness = eventHarness({
      invoke: async (call) => {
        signal = call.signal;
        return await invocation.promise;
      },
    });
    harness.events.handleServerRequest("rpc-cancel", "item/tool/call", toolRequest());
    harness.events.dispose();
    expect(signal?.aborted).toBe(true);
    invocation.resolve({ success: true, text: "must not escape" });
    await flush();
    expect(harness.writes).toEqual([]);
  });

  it("bounds model-visible results by UTF-8 bytes without splitting a code point", async () => {
    const harness = eventHarness({
      invoke: async () => ({ success: true, text: "🙂".repeat(10_000) }),
    });
    try {
      harness.events.handleServerRequest("rpc-bytes", "item/tool/call", toolRequest());
      await flush();
      const text = (harness.writes[0].result as JsonObject)
        .contentItems as Array<{ text: string }>;
      expect(Buffer.byteLength(text[0].text, "utf8")).toBeLessThanOrEqual(32 * 1024);
      expect(text[0].text).not.toContain("�");
    } finally {
      harness.events.dispose();
    }
  });

  it("closes the run when the exact result cannot be written", async () => {
    const harness = eventHarness({ writeMessage: () => false });
    try {
      harness.events.handleServerRequest("rpc-write-failure", "item/tool/call", toolRequest());
      await flush();
      expect(harness.cancel).toHaveBeenCalledOnce();
    } finally {
      harness.events.dispose();
    }
  });
});
