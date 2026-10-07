// @inertia-test-suite portable
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CodexSubagentLifecycle,
  type CodexSubagentProjection,
  type CodexSubagentUpdate,
} from "../../src/server/codex/app-server-subagents";
import type { JsonObject } from "../../src/server/codex/protocol";
import { shouldAcceptCodexSubagentProjection } from "../../src/server/codex/app-server-subagent-projection";
import { startCodexAppServerRun } from "../../src/server/codex-app-server";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  waitFor,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";

const ROOT_THREAD_ID = "root-thread";
const ROOT_TURN_ID = "root-turn";

function lifecycleHarness() {
  const updates: CodexSubagentUpdate[] = [];
  const projections = new Map<string, CodexSubagentProjection>();
  const rejectMalformed = vi.fn();
  let sequence = 0;
  let cancelRequested = false;
  const lifecycle = new CodexSubagentLifecycle({
    rootThreadId: () => ROOT_THREAD_ID,
    rootTurnId: () => ROOT_TURN_ID,
    cancelRequested: () => cancelRequested,
    emitSubagent: (update, authority, isLive = true) => {
      sequence += 1;
      updates.push({ sequence, ...update, isLive });
      if (update.providerAgentId) {
        projections.set(update.providerAgentId, {
          status: update.status,
          authority,
          isLive,
        });
      }
    },
    projection: (providerAgentId) => projections.get(providerAgentId),
    rejectMalformed,
  });
  return {
    lifecycle, projections, rejectMalformed, updates,
    requestCancel: () => { cancelRequested = true; },
  };
}

function activity(
  lifecycle: CodexSubagentLifecycle,
  childThreadId: string,
  callId = `call-${childThreadId}`,
): void {
  lifecycle.handleItem({
    type: "subAgentActivity",
    id: callId,
    kind: "started",
    agentThreadId: childThreadId,
    agentPath: `/root/${childThreadId}`,
  }, "completed", ROOT_THREAD_ID);
}

function childTurn(
  lifecycle: CodexSubagentLifecycle,
  method: "turn/started" | "turn/completed",
  threadId: string,
  turnId: string,
  status: string,
): void {
  lifecycle.handleNotification(method, {
    threadId,
    turn: { id: turnId, status, items: [], error: null },
  });
}

const CHILD_TOKEN_USAGE = {
  total: {
    totalTokens: 5_400,
    inputTokens: 5_000,
    cachedInputTokens: 1_200,
    cacheWriteInputTokens: 90,
    outputTokens: 400,
    reasoningOutputTokens: 64,
  },
  last: {
    totalTokens: 900,
    inputTokens: 800,
    cachedInputTokens: 300,
    cacheWriteInputTokens: 50,
    outputTokens: 100,
    reasoningOutputTokens: 16,
  },
  modelContextWindow: 258_400,
};

const CHILD_TASK_USAGE = {
  totalTokens: 5_400,
  inputTokens: 800,
  cachedInputTokens: 300,
  cacheWriteInputTokens: 50,
  outputTokens: 100,
  reasoningOutputTokens: 16,
  contextTokens: 900,
  maxContextTokens: 258_400,
};

function tokenUsage(
  lifecycle: CodexSubagentLifecycle,
  threadId: string,
  usage: unknown,
): void {
  lifecycle.handleNotification("thread/tokenUsage/updated", {
    threadId,
    turnId: `${threadId}-turn`,
    tokenUsage: usage,
  });
}

function childItem(
  lifecycle: CodexSubagentLifecycle,
  method: "item/started" | "item/completed",
  threadId: string,
  item: JsonObject,
): void {
  lifecycle.handleNotification(method, {
    threadId,
    turnId: `${threadId}-turn`,
    item,
  });
}

describe("Codex delegated-agent telemetry", () => {
  it("maps child usage like the root: total from total, context and breakdown from last, window from modelContextWindow", () => {
    const { lifecycle, rejectMalformed, updates } = lifecycleHarness();
    activity(lifecycle, "usage-child-a");
    activity(lifecycle, "usage-child-b");
    tokenUsage(lifecycle, "usage-child-b", CHILD_TOKEN_USAGE);

    expect(rejectMalformed).not.toHaveBeenCalled();
    expect(updates.at(-1)).toEqual({
      sequence: 3,
      providerTaskId: null,
      providerAgentId: "usage-child-b",
      parentProviderAgentId: null,
      parentProviderToolUseId: null,
      providerToolUseId: null,
      providerRole: null,
      providerName: null,
      providerStatus: null,
      status: "running",
      description: null,
      progress: null,
      result: null,
      usage: CHILD_TASK_USAGE,
      isLive: true,
    });
    expect(updates.filter(({ providerAgentId }) =>
      providerAgentId === "usage-child-a")).not.toContainEqual(
      expect.objectContaining({ usage: expect.anything() }),
    );
  });

  it("attaches nested child usage to that child with its own parent identity", () => {
    const { lifecycle, updates } = lifecycleHarness();
    lifecycle.handleNotification("thread/started", {
      thread: { id: "usage-parent", parentThreadId: ROOT_THREAD_ID },
    });
    lifecycle.handleNotification("thread/started", {
      thread: { id: "usage-grandchild", parentThreadId: "usage-parent" },
    });
    tokenUsage(lifecycle, "usage-grandchild", CHILD_TOKEN_USAGE);

    expect(updates.at(-1)).toMatchObject({
      providerAgentId: "usage-grandchild",
      parentProviderAgentId: "usage-parent",
      usage: CHILD_TASK_USAGE,
    });
  });

  it.each([
    ["a string", "not usage"],
    ["an empty object", {}],
    ["negative totals", { total: { totalTokens: -1 }, last: { totalTokens: -1 } }],
    ["fractional counts", { last: { totalTokens: 1.5 }, modelContextWindow: 0.5 }],
    ["counts beyond the token ceiling", { total: { totalTokens: 1e13 } }],
  ])("ignores malformed child usage: %s", (_label, usage) => {
    const { lifecycle, rejectMalformed, updates } = lifecycleHarness();
    activity(lifecycle, "malformed-usage-child");
    tokenUsage(lifecycle, "malformed-usage-child", usage);

    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toHaveProperty("usage");
    expect(rejectMalformed).not.toHaveBeenCalled();
  });

  it("never attaches usage from an unknown thread to an owned child", () => {
    const { lifecycle, rejectMalformed, updates } = lifecycleHarness();
    tokenUsage(lifecycle, "stranger-thread", CHILD_TOKEN_USAGE);
    activity(lifecycle, "owned-child");
    tokenUsage(lifecycle, "stranger-thread", CHILD_TOKEN_USAGE);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ providerAgentId: "owned-child" });
    expect(updates[0]).not.toHaveProperty("usage");
    expect(JSON.stringify(updates)).not.toContain("stranger-thread");
    expect(rejectMalformed).not.toHaveBeenCalled();
  });

  it("keeps only the latest provisional usage, drops provisional activity, and replays usage once owned", () => {
    const { lifecycle, rejectMalformed, updates } = lifecycleHarness();
    childTurn(lifecycle, "turn/started", "late-child", "late-turn", "inProgress");
    for (let index = 1; index <= 12; index += 1) {
      tokenUsage(lifecycle, "late-child", {
        ...CHILD_TOKEN_USAGE,
        total: { totalTokens: index * 100 },
      });
    }
    childItem(lifecycle, "item/started", "late-child", {
      id: "late-command",
      type: "commandExecution",
      command: "npm test",
    });

    expect(updates).toEqual([]);
    expect(rejectMalformed).not.toHaveBeenCalled();
    activity(lifecycle, "late-child");

    expect(updates.map(({ status }) => status)).toEqual([
      "running",
      "running",
      "running",
    ]);
    expect(updates.filter((update) => "usage" in update)).toEqual([
      expect.objectContaining({
        providerAgentId: "late-child",
        usage: { ...CHILD_TASK_USAGE, totalTokens: 1_200 },
      }),
    ]);
    expect(updates.some((update) => "activity" in update)).toBe(false);
  });

  it("drops usage for a thread without provisional lifecycle and opens no provisional slot", () => {
    const { lifecycle, rejectMalformed, updates } = lifecycleHarness();
    for (let index = 0; index < 129; index += 1) {
      tokenUsage(lifecycle, `usage-only-${index}`, CHILD_TOKEN_USAGE);
    }
    for (let index = 0; index < 128; index += 1) {
      childTurn(
        lifecycle,
        "turn/started",
        `lifecycle-${index}`,
        `lifecycle-turn-${index}`,
        "inProgress",
      );
    }

    expect(updates).toEqual([]);
    expect(rejectMalformed).not.toHaveBeenCalled();
    activity(lifecycle, "usage-only-0");
    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toHaveProperty("usage");
  });

  it("keeps provisional usage outside the per-child lifecycle event limit", () => {
    const { lifecycle, rejectMalformed, updates } = lifecycleHarness();
    tokenUsage(lifecycle, "busy-child", CHILD_TOKEN_USAGE);
    childTurn(lifecycle, "turn/started", "busy-child", "busy-turn", "inProgress");
    tokenUsage(lifecycle, "busy-child", CHILD_TOKEN_USAGE);
    for (let index = 0; index < 7; index += 1) {
      lifecycle.handleNotification("thread/status/changed", {
        threadId: "busy-child",
        status: { type: "active", activeFlags: [] },
      });
      tokenUsage(lifecycle, "busy-child", CHILD_TOKEN_USAGE);
    }

    expect(rejectMalformed).not.toHaveBeenCalled();
    activity(lifecycle, "busy-child");
    expect(updates.filter((update) => "usage" in update)).toHaveLength(1);
    expect(updates.at(-1)).toMatchObject({ usage: CHILD_TASK_USAGE });
  });

  it("still fails closed when provisional lifecycle events exceed the per-child limit", () => {
    const { lifecycle, rejectMalformed } = lifecycleHarness();
    childTurn(lifecycle, "turn/started", "flooding-child", "flood-turn", "inProgress");
    tokenUsage(lifecycle, "flooding-child", CHILD_TOKEN_USAGE);
    for (let index = 0; index < 8; index += 1) {
      lifecycle.handleNotification("thread/status/changed", {
        threadId: "flooding-child",
        status: { type: "active", activeFlags: [] },
      });
    }

    expect(rejectMalformed).toHaveBeenCalledOnce();
    expect(rejectMalformed).toHaveBeenCalledWith(
      "Codex exceeded the 8-event provisional child limit.",
    );
  });

  it("uses the model requested by the spawning collaboration item", () => {
    const { lifecycle, updates } = lifecycleHarness();
    lifecycle.handleItem({
      type: "collabAgentToolCall",
      id: "spawn-with-model",
      tool: "spawnAgent",
      senderThreadId: ROOT_THREAD_ID,
      receiverThreadIds: ["model-child", "default-model-child"],
      prompt: "Review the protocol.",
      model: "gpt-5.5-codex",
      reasoningEffort: "high",
      agentsStates: {
        "model-child": { status: "pendingInit" },
        "default-model-child": { status: "pendingInit" },
      },
    }, "started", ROOT_THREAD_ID);
    lifecycle.handleItem({
      type: "collabAgentToolCall",
      id: "spawn-default-model",
      tool: "spawnAgent",
      senderThreadId: ROOT_THREAD_ID,
      receiverThreadIds: ["null-model-child"],
      model: null,
      agentsStates: { "null-model-child": { status: "pendingInit" } },
    }, "started", ROOT_THREAD_ID);

    expect(updates.find(({ providerAgentId }) =>
      providerAgentId === "model-child")).toMatchObject({
      model: "gpt-5.5-codex",
      status: "queued",
    });
    expect(updates.find(({ providerAgentId }) =>
      providerAgentId === "null-model-child")).not.toHaveProperty("model");
    expect(JSON.stringify(updates)).not.toContain("high");
  });

  it("labels child activity with the parent's item labels and never includes command output", () => {
    const { lifecycle, updates } = lifecycleHarness();
    activity(lifecycle, "busy-child");
    const items: JsonObject[] = [
      {
        id: "child-command",
        type: "commandExecution",
        command: "npm run check && cat .env",
        aggregatedOutput: "SECRET_OUTPUT",
      },
      { id: "child-plain-command", type: "commandExecution", command: "cat .env" },
      { id: "child-mcp", type: "mcpToolCall", server: "docs", tool: "search", arguments: { q: "SECRET_ARGUMENT" } },
      { id: "child-files", type: "fileChange", changes: [{ path: "src/secret.ts", kind: "update", diff: "" }] },
      { id: "child-dynamic", type: "dynamicToolCall", tool: "preview" },
      { id: "child-web", type: "webSearch", query: "SECRET_QUERY", action: { type: "search", query: "SECRET_QUERY" } },
      { id: "child-reasoning", type: "reasoning", summary: [] },
      { id: "child-long-mcp", type: "mcpToolCall", server: "s".repeat(120), tool: "t".repeat(160) },
      { id: "child-message", type: "agentMessage", text: "Not an activity." },
    ];
    for (const item of items) {
      childItem(lifecycle, "item/started", "busy-child", item);
    }
    childItem(lifecycle, "item/completed", "busy-child", {
      id: "child-command",
      type: "commandExecution",
      command: "npm run check",
      aggregatedOutput: "SECRET_OUTPUT",
    });

    const activities = updates.flatMap((update) =>
      "activity" in update ? [update.activity] : []);
    expect(activities).toEqual([
      "npm run check",
      "Command",
      "MCP · docs/search",
      "File change",
      "Tool · preview",
      "Search the web",
      "Thinking",
      `MCP · ${"s".repeat(120)}/${"t".repeat(160)}`.slice(0, 200),
    ]);
    expect(updates.slice(1)).toEqual(activities.map(() => expect.objectContaining({
      providerAgentId: "busy-child",
      status: "running",
      isLive: true,
      progress: null,
      result: null,
    })));
    const serialized = JSON.stringify(updates);
    for (const secret of ["SECRET_OUTPUT", ".env", "SECRET_ARGUMENT", "src/secret.ts", "SECRET_QUERY"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("keeps the current status and authority for telemetry-only updates", () => {
    const { lifecycle, projections, updates } = lifecycleHarness();
    activity(lifecycle, "waiting-child");
    lifecycle.handleNotification("thread/status/changed", {
      threadId: "waiting-child",
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    });
    tokenUsage(lifecycle, "waiting-child", CHILD_TOKEN_USAGE);
    childItem(lifecycle, "item/started", "waiting-child", {
      id: "waiting-command",
      type: "commandExecution",
      command: "npm test",
    });

    expect(updates.slice(-2)).toEqual([
      expect.objectContaining({ status: "waiting", usage: CHILD_TASK_USAGE }),
      expect.objectContaining({ status: "waiting", activity: "npm test" }),
    ]);
    expect(projections.get("waiting-child")).toEqual({
      status: "waiting",
      authority: "state",
      isLive: true,
    });
    expect(updates.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4]);
  });

  it("enriches a settled child with final usage but never revives it with activity", () => {
    const { lifecycle, projections, updates } = lifecycleHarness();
    activity(lifecycle, "settled-child");
    childTurn(lifecycle, "turn/started", "settled-child", "settled-turn", "inProgress");
    childTurn(lifecycle, "turn/completed", "settled-child", "settled-turn", "completed");
    const settledCount = updates.length;
    childItem(lifecycle, "item/started", "settled-child", {
      id: "late-command",
      type: "commandExecution",
      command: "npm test",
    });
    tokenUsage(lifecycle, "settled-child", CHILD_TOKEN_USAGE);

    expect(updates).toHaveLength(settledCount + 1);
    expect(updates.at(-1)).toMatchObject({
      providerAgentId: "settled-child",
      status: "completed",
      isLive: false,
      usage: CHILD_TASK_USAGE,
    });
    expect(updates.at(-1)).not.toHaveProperty("activity");
    expect(projections.get("settled-child")).toEqual({
      status: "completed",
      authority: "turn",
      isLive: false,
    });
  });
});

describe("Codex delegated-agent lifecycle", () => {
  it("buffers bounded lifecycle traffic until an owned activity registers the child", () => {
    const { lifecycle, updates } = lifecycleHarness();
    lifecycle.handleNotification("thread/status/changed", {
      threadId: "child-late-registration",
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    });
    childTurn(
      lifecycle,
      "turn/started",
      "child-late-registration",
      "child-turn",
      "inProgress",
    );
    childTurn(
      lifecycle,
      "turn/completed",
      "child-late-registration",
      "child-turn",
      "completed",
    );

    expect(updates).toEqual([]);
    expect(lifecycle.interruptibleTurns()).toEqual([]);
    activity(lifecycle, "child-late-registration");

    expect(updates.map(({ status }) => status)).toEqual([
      "running",
      "waiting",
      "running",
      "completed",
    ]);
    expect(updates.at(-1)).toMatchObject({
      providerAgentId: "child-late-registration",
      providerStatus: "completed",
      status: "completed",
      isLive: false,
    });
  });

  it("tracks provisional live turns for cancellation without projecting foreign traffic", () => {
    const { lifecycle, updates } = lifecycleHarness();
    childTurn(
      lifecycle,
      "turn/started",
      "provisional-child",
      "provisional-turn",
      "inProgress",
    );

    expect(updates).toEqual([]);
    expect(lifecycle.interruptibleTurns()).toEqual([{
      threadId: "provisional-child",
      turnId: "provisional-turn",
    }]);

    activity(lifecycle, "provisional-child");
    expect(lifecycle.interruptibleTurns()).toEqual([{
      threadId: "provisional-child",
      turnId: "provisional-turn",
    }]);
  });

  it("fails closed instead of silently dropping provisional child overflow", () => {
    const { lifecycle, rejectMalformed, updates } = lifecycleHarness();
    for (let index = 0; index < 129; index += 1) {
      childTurn(
        lifecycle,
        "turn/started",
        `provisional-${index}`,
        `turn-${index}`,
        "inProgress",
      );
    }

    expect(updates).toEqual([]);
    expect(rejectMalformed).toHaveBeenCalledOnce();
    expect(rejectMalformed).toHaveBeenCalledWith(
      "Codex exceeded the 128-thread provisional child limit.",
    );
  });

  it("uses structured spawn metadata but never raw final answers as terminal authority", () => {
    const { lifecycle, updates } = lifecycleHarness();
    lifecycle.handleNotification("rawResponseItem/completed", {
      threadId: ROOT_THREAD_ID,
      turnId: ROOT_TURN_ID,
      item: {
        type: "function_call",
        name: "spawn_agent",
        namespace: "collaboration",
        call_id: "spawn-call",
        arguments: JSON.stringify({
          task_name: "provider_audit",
          message: "Audit provider lifecycle.",
        }),
      },
    });
    lifecycle.handleNotification("rawResponseItem/completed", {
      threadId: ROOT_THREAD_ID,
      turnId: ROOT_TURN_ID,
      item: { type: "agent_message", text: "FINAL_ANSWER: untrusted" },
    });
    activity(lifecycle, "metadata-child", "spawn-call");

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      providerAgentId: "metadata-child",
      providerName: "provider_audit",
      description: "Audit provider lifecycle.",
      status: "running",
    });
  });

  it("registers generated thread_spawn sources and settles exact child turns once", () => {
    const { lifecycle, updates } = lifecycleHarness();
    lifecycle.handleNotification("thread/started", {
      thread: {
        id: "source-child",
        parentThreadId: null,
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: ROOT_THREAD_ID,
              agent_nickname: "Source scout",
              agent_role: "researcher",
            },
          },
        },
        preview: "Inspect generated protocol.",
      },
    });
    childTurn(
      lifecycle,
      "turn/started",
      "source-child",
      "source-turn",
      "inProgress",
    );
    childTurn(
      lifecycle,
      "turn/completed",
      "source-child",
      "source-turn",
      "completed",
    );
    childTurn(
      lifecycle,
      "turn/completed",
      "source-child",
      "source-turn",
      "completed",
    );

    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerAgentId: "source-child",
        providerName: "Source scout",
        providerRole: "researcher",
        status: "running",
      }),
      expect.objectContaining({
        providerAgentId: "source-child",
        providerStatus: "completed",
        status: "completed",
        isLive: false,
      }),
    ]));
    expect(updates.filter(({ status }) => status === "completed"))
      .toHaveLength(1);
  });

  it.each([
    ["error", { error: { message: "Child failed." }, willRetry: false }, "failed"],
    ["thread/status/changed", { status: { type: "systemError" } }, "failed"],
    ["thread/closed", {}, "unknown"],
  ] as const)("settles %s as a non-live terminal", (method, extra, status) => {
    const { lifecycle, updates } = lifecycleHarness();
    activity(lifecycle, "terminal-child");
    childTurn(
      lifecycle,
      "turn/started",
      "terminal-child",
      "terminal-turn",
      "inProgress",
    );
    lifecycle.handleNotification(method, {
      threadId: "terminal-child",
      ...extra,
    } as JsonObject);

    expect(updates.at(-1)).toMatchObject({
      providerAgentId: "terminal-child",
      status,
      isLive: false,
    });
    expect(lifecycle.interruptibleTurns()).toEqual([]);
  });

  it.each([
    [
      { message: "Guardian interrupted the turn after 3 consecutive approval denials.", codexErrorInfo: "tooManyDenials" },
      false, "failed",
      "Codex stopped the turn after repeated approval denials.\nGuardian interrupted the turn after 3 consecutive approval denials.",
    ],
    [{ codexErrorInfo: "tooManyDenials" }, false, "failed", "Codex stopped the turn after repeated approval denials."],
    [{}, false, "failed", "Codex interrupted the turn before completion."],
    [{ message: "Guardian interrupted the turn.", codexErrorInfo: "tooManyDenials" }, true, "interrupted", "Partial child output"],
    [null, false, "interrupted", "Partial child output"],
    ["UNEXPECTED_PAYLOAD", false, "interrupted", "Partial child output"],
  ] as const)("classifies an interrupted child turn with error %j (cancel requested: %s) as %s", (error, cancel, status, result) => {
    const { lifecycle, requestCancel, updates } = lifecycleHarness();
    activity(lifecycle, "guarded-child");
    childTurn(lifecycle, "turn/started", "guarded-child", "guarded-turn", "inProgress");
    lifecycle.handleNotification("item/agentMessage/delta", {
      threadId: "guarded-child", itemId: "child-message", delta: "Partial child output",
    });
    if (cancel) requestCancel();
    lifecycle.handleNotification("turn/completed", {
      threadId: "guarded-child",
      turn: { id: "guarded-turn", status: "interrupted", items: [], error },
    });

    expect(updates.at(-1)).toMatchObject({
      providerAgentId: "guarded-child",
      providerStatus: "interrupted",
      status,
      result,
      isLive: false,
    });
    expect(JSON.stringify(updates)).not.toContain("UNEXPECTED_PAYLOAD");
    expect(lifecycle.interruptibleTurns()).toEqual([]);
  });

  it("keeps ancestry immutable and fails closed on unbounded collaboration receivers", () => {
    const { lifecycle, rejectMalformed, updates } = lifecycleHarness();
    lifecycle.handleItem({
      type: "collabAgentToolCall",
      id: "spawn-topology",
      tool: "spawnAgent",
      senderThreadId: ROOT_THREAD_ID,
      receiverThreadIds: ["topology-a", "topology-b"],
      agentsStates: {
        "topology-a": { status: "running" },
        "topology-b": { status: "running" },
      },
    }, "started", ROOT_THREAD_ID);
    lifecycle.handleItem({
      type: "collabAgentToolCall",
      id: "cross-agent",
      tool: "sendInput",
      senderThreadId: "topology-a",
      receiverThreadIds: ["topology-b", ROOT_THREAD_ID, "topology-a"],
      agentsStates: { "topology-b": { status: "running" } },
    }, "completed", "topology-a");

    expect(updates.filter(({ providerAgentId }) =>
      providerAgentId === "topology-b").at(-1)).toMatchObject({
      parentProviderAgentId: null,
    });
    expect(new Set(updates.map(({ providerAgentId }) => providerAgentId)))
      .toEqual(new Set(["topology-a", "topology-b"]));

    lifecycle.handleItem({
      type: "collabAgentToolCall",
      id: "overflow",
      tool: "spawnAgent",
      senderThreadId: ROOT_THREAD_ID,
      receiverThreadIds: Array.from(
        { length: 129 },
        (_, index) => `overflow-${index}`,
      ),
    }, "started", ROOT_THREAD_ID);
    expect(rejectMalformed).toHaveBeenCalledOnce();
  });
});

describe("Codex delegated-agent revival", () => {
  it("revives a settled child when sendInput starts a new turn on it", () => {
    const accepted: CodexSubagentUpdate[] = [];
    const projections = new Map<string, CodexSubagentProjection>();
    let sequence = 0;
    const lifecycle = new CodexSubagentLifecycle({
      rootThreadId: () => ROOT_THREAD_ID,
      rootTurnId: () => ROOT_TURN_ID,
      cancelRequested: () => false,
      emitSubagent: (update, authority, isLive = true) => {
        const id = update.providerAgentId!;
        if (!shouldAcceptCodexSubagentProjection(projections.get(id), update, authority, isLive)) return;
        projections.set(id, { status: update.status, authority, isLive });
        sequence += 1;
        accepted.push({ sequence, ...update, isLive });
      },
      projection: (id) => projections.get(id),
      rejectMalformed: vi.fn(),
    });
    lifecycle.handleItem({
      type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", senderThreadId: ROOT_THREAD_ID,
      receiverThreadIds: ["child"], agentsStates: { child: { status: "running" } },
    }, "completed", ROOT_THREAD_ID);
    childTurn(lifecycle, "turn/started", "child", "t1", "inProgress");
    childTurn(lifecycle, "turn/completed", "child", "t1", "completed");
    expect(projections.get("child")).toMatchObject({ status: "completed", isLive: false });

    lifecycle.handleItem({
      type: "collabAgentToolCall", id: "send", tool: "sendInput", senderThreadId: ROOT_THREAD_ID,
      receiverThreadIds: ["child"], agentsStates: { child: { status: "running" } },
    }, "completed", ROOT_THREAD_ID);
    childTurn(lifecycle, "turn/started", "child", "t2", "inProgress");

    expect(lifecycle.interruptibleTurns()).toEqual([{ threadId: "child", turnId: "t2" }]);
    expect(projections.get("child")).toMatchObject({ status: "running", isLive: true, authority: "turn" });
    expect(accepted.at(-1)).toMatchObject({ status: "running", isLive: true, revived: true });

    childTurn(lifecycle, "turn/completed", "child", "t2", "completed");
    expect(projections.get("child")).toMatchObject({ status: "completed", isLive: false });
  });
});

describe("Codex delegated-agent cancellation", () => {
  it("interrupts registered and provisional child turns before the root", async () => {
    const root = portableFixtureRoot("codex child cancellation");
    try {
      const executable = portableNodeExecutable(root, "codex");
      const capturePath = join(root, "capture.jsonl");
      const readyPath = join(root, "children-ready");
      writeNodeSubcommand(root, "app-server", `
const fs = require("node:fs");
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const capture = (value) => fs.appendFileSync(
  process.env.CODEX_TEST_CAPTURE,
  JSON.stringify(value) + "\\n",
);
const rootThreadId = "cancel-root";
const rootTurnId = "cancel-root-turn";
const childrenReadyRequestId = "children-ready";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  capture(message);
  if (message.id === childrenReadyRequestId && message.error) {
    fs.writeFileSync(process.env.CODEX_TEST_READY, "ready");
    return;
  }
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fixture" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: rootThreadId } } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: {
      turn: { id: rootTurnId, status: "inProgress" },
    } });
    send({ method: "turn/started", params: {
      threadId: rootThreadId,
      turn: { id: rootTurnId, status: "inProgress" },
    } });
    send({ method: "item/completed", params: {
      threadId: rootThreadId,
      turnId: rootTurnId,
      item: {
        type: "subAgentActivity",
        id: "known-call",
        kind: "started",
        agentThreadId: "known-child",
        agentPath: "/root/known-child",
      },
    } });
    send({ method: "turn/started", params: {
      threadId: "known-child",
      turn: { id: "known-turn", status: "inProgress" },
    } });
    send({ method: "turn/started", params: {
      threadId: "provisional-child",
      turn: { id: "provisional-turn", status: "inProgress" },
    } });
    for (const childThreadId of ["known-child", "provisional-child"]) {
      send({ method: "item/started", params: {
        threadId: childThreadId,
        turnId: childThreadId === "known-child" ? "known-turn" : "provisional-turn",
        item: { id: childThreadId + "-command", type: "commandExecution", command: "npm test" },
      } });
      send({ method: "thread/tokenUsage/updated", params: {
        threadId: childThreadId,
        turnId: childThreadId === "known-child" ? "known-turn" : "provisional-turn",
        tokenUsage: { total: { totalTokens: 300 }, last: { totalTokens: 120 }, modelContextWindow: 1000 },
      } });
    }
    send({
      id: childrenReadyRequestId,
      method: "fixture/childrenReady",
      params: {},
    });
    return;
  }
  if (message.method === "turn/interrupt") {
    const { threadId, turnId } = message.params;
    // One child intentionally never acknowledges. The client must still
    // reach and interrupt the root after its bounded per-child deadline.
    if (threadId === "provisional-child") return;
    send({ id: message.id, result: {} });
    send({ method: "turn/completed", params: {
      threadId,
      turn: { id: turnId, status: "interrupted" },
    } });
  }
});
`);
      const subagents: CodexSubagentUpdate[] = [];
      const run = startCodexAppServerRun({
        executable,
        environment: {
          ...process.env,
          CODEX_TEST_CAPTURE: capturePath,
          CODEX_TEST_READY: readyPath,
        },
        cwd: root,
        prompt: "Cancel all delegated work",
        planMode: false,
        access: "full",
        onSubagent: (event) => subagents.push(event),
      });

      await waitFor("both child turns to reach the client", () =>
        existsSync(readyPath));
      // The marker follows the client's response to a request queued after
      // both notifications, so cancellation observes both child turns.
      run.cancel();

      await expect(run.result).resolves.toMatchObject({ status: "cancelled" });
      const messages = readFileSync(capturePath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as JsonObject);
      const interrupted = messages
        .filter(({ method }) => method === "turn/interrupt")
        .map(({ params }) => params as JsonObject);
      expect(interrupted.slice(0, -1)).toEqual(expect.arrayContaining([
        { threadId: "known-child", turnId: "known-turn" },
        { threadId: "provisional-child", turnId: "provisional-turn" },
      ]));
      expect(interrupted.at(-1)).toEqual({
        threadId: "cancel-root",
        turnId: "cancel-root-turn",
      });
      expect(subagents).toContainEqual(expect.objectContaining({
        providerAgentId: "known-child",
        activity: "npm test",
      }));
      expect(subagents).toContainEqual(expect.objectContaining({
        providerAgentId: "known-child",
        usage: expect.objectContaining({
          totalTokens: 300,
          contextTokens: 120,
          maxContextTokens: 1000,
        }),
      }));
      expect(subagents.filter(({ providerAgentId }) =>
        providerAgentId === "known-child").at(-1)).toMatchObject({
        status: "interrupted",
        isLive: false,
      });
      expect(JSON.stringify(subagents)).not.toContain("provisional-child");
    } finally {
      await removePortableFixture(root);
    }
  });
});
