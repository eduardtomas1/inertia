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
  const lifecycle = new CodexSubagentLifecycle({
    rootThreadId: () => ROOT_THREAD_ID,
    rootTurnId: () => ROOT_TURN_ID,
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
  return { lifecycle, projections, rejectMalformed, updates };
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
    } finally {
      await removePortableFixture(root);
    }
  });
});
