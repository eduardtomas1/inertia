// @inertia-test-suite portable
import { describe, expect, it, vi } from "vitest";

import {
  CodexAppServerEvents,
  type CodexAppServerEventHost,
} from "../../src/server/codex/app-server-events";
import type { CodexRunPhase } from "../../src/server/codex/app-server-config";
import { CappedTextBuffer, type JsonObject } from "../../src/server/codex/protocol";
import type { AgentApprovalRequest, AgentInputRequest } from "../../src/server/provider/interactions";

const ROOT_THREAD_ID = "interaction-root";
const ROOT_TURN_ID = "interaction-turn";

function inputParams(
  threadId = ROOT_THREAD_ID,
  turnId = ROOT_TURN_ID,
  itemId = "input-item",
): JsonObject {
  return {
    threadId,
    turnId,
    itemId,
    questions: [{
      id: "choice",
      header: "Direction",
      question: "Which path should Codex take?",
      options: [{ label: "Safe", description: "Use the bounded path." }],
    }],
  };
}

function interactionHarness() {
  let phase: CodexRunPhase = "running";
  let activeTurnId: string | undefined = ROOT_TURN_ID;
  let requestedTurnId: string | null | undefined;
  let cancelled = false;
  const inputs: AgentInputRequest[] = [];
  const approvals: AgentApprovalRequest[] = [];
  const resolved: Array<[string, string]> = [];
  const writes: JsonObject[] = [];
  const cancel = vi.fn();
  const rememberFailure = vi.fn();
  const host: CodexAppServerEventHost = {
    options: {
      executable: "/fake/codex",
      environment: {},
      cwd: "/workspace",
      prompt: "Exercise interactions",
      planMode: false,
      access: "full",
      onInputRequest: (request) => inputs.push(request),
      onApproval: (request) => approvals.push(request),
      onApprovalResolved: (requestId, decision) => resolved.push([requestId, decision]),
    },
    resultText: new CappedTextBuffer(1_024),
    isSettled: () => phase === "settled",
    phase: () => phase,
    setPhase: (value) => {
      phase = value;
    },
    providerThreadId: () => ROOT_THREAD_ID,
    activeTurnId: () => activeTurnId,
    requestedTurnId: () => requestedTurnId,
    setActiveTurnId: (value) => {
      activeTurnId = value;
    },
    cancelRequested: () => cancelled,
    lastError: () => undefined,
    setLastError: vi.fn(),
    setLastProtocolMethod: vi.fn(),
    setLastActivityId: vi.fn(),
    setTerminalEvent: vi.fn(),
    writeMessage: (message) => {
      writes.push(message);
      return true;
    },
    cancel,
    finish: vi.fn(),
    rememberFailure,
  };
  return {
    cancel,
    events: new CodexAppServerEvents(host),
    inputs,
    approvals,
    resolved,
    rememberFailure,
    writes,
    awaitStartResponse: () => {
      phase = "starting-turn";
      activeTurnId = undefined;
      requestedTurnId = null;
    },
    receiveStartResponse: (turnId: string) => { requestedTurnId = turnId; },
    changeActiveTurn: (turnId: string) => { activeTurnId = turnId; },
    cancelRun: () => { cancelled = true; },
  };
}

function approvalParams(threadId = ROOT_THREAD_ID, turnId = ROOT_TURN_ID): JsonObject {
  return { threadId, turnId, itemId: "command-1", startedAtMs: 1, command: "npm test", cwd: "/workspace" };
}

function registerChild(harness: ReturnType<typeof interactionHarness>): void {
  harness.events.handleNotification("item/completed", {
    threadId: ROOT_THREAD_ID,
    turnId: ROOT_TURN_ID,
    item: {
      type: "subAgentActivity", id: "child-call", kind: "started",
      agentThreadId: "approval-child", agentPath: "/root/approval-child",
    },
  });
}

describe("Codex native approval turn authority", () => {
  it.each([
    ["item/commandExecution/requestApproval", { command: "npm test", cwd: "/workspace" }],
    ["item/fileChange/requestApproval", { grantRoot: "/workspace" }],
    ["item/permissions/requestApproval", { permissions: { network: { enabled: true } } }],
  ] as const)("rejects stale and missing ownership for %s", (method, details) => {
    const stale = interactionHarness();
    try {
      stale.events.handleServerRequest("approval", method, { threadId: ROOT_THREAD_ID, turnId: "previous-turn", ...details });
      expect(stale.approvals).toEqual([]);
      expect(stale.writes).toEqual([{ id: "approval", error: expect.objectContaining({ code: -32602 }) }]);
      expect(stale.cancel).not.toHaveBeenCalled();
    } finally { stale.events.dispose(); }
    for (const owner of [
      { threadId: "other-thread", turnId: ROOT_TURN_ID },
      { threadId: ROOT_THREAD_ID },
      { turnId: ROOT_TURN_ID },
      { threadId: ROOT_THREAD_ID, turnId: null },
      { threadId: ROOT_THREAD_ID, turnId: "bad\0turn" },
    ]) {
      const h = interactionHarness();
      try {
        h.events.handleServerRequest("approval", method, { ...owner, ...details });
        expect(h.approvals).toEqual([]);
        expect(h.writes).toContainEqual({ id: "approval", error: expect.objectContaining({ code: -32602 }) });
        expect(h.cancel).toHaveBeenCalledOnce();
      } finally { h.events.dispose(); }
    }
  });

  it.each([ROOT_TURN_ID, "previous-turn"])("holds early approvals until the exact start response (%s)", (turnId) => {
    const h = interactionHarness();
    try {
      h.awaitStartResponse();
      h.events.handleNotification("turn/started", { threadId: ROOT_THREAD_ID, turn: { id: turnId, status: "inProgress" } });
      h.events.handleServerRequest("early", "item/commandExecution/requestApproval", approvalParams(ROOT_THREAD_ID, turnId));
      expect(h.approvals).toEqual([]);
      expect(h.writes).toEqual([]);
      h.receiveStartResponse(ROOT_TURN_ID);
      h.events.replayPreResponseTurnNotifications(ROOT_TURN_ID);
      if (turnId === ROOT_TURN_ID) {
        expect(h.approvals).toHaveLength(1);
        expect(h.events.respondToApproval(h.approvals[0]!.requestId, "approve")).toBe(true);
        expect(h.writes).toEqual([{ id: "early", result: { decision: "accept" } }]);
      } else {
        expect(h.approvals).toEqual([]);
        expect(h.writes).toContainEqual({ id: "early", error: expect.any(Object) });
      }
    } finally { h.events.dispose(); }
  });

  it("accepts a receipt-confirmed turn before its turn/started notification", () => {
    const h = interactionHarness();
    try {
      h.awaitStartResponse();
      h.events.handleServerRequest("early", "item/commandExecution/requestApproval", approvalParams());
      h.receiveStartResponse(ROOT_TURN_ID);
      h.events.replayPreResponseTurnNotifications(ROOT_TURN_ID);
      expect(h.approvals).toHaveLength(1);
      expect(h.events.respondToApproval(h.approvals[0]!.requestId, "approve")).toBe(true);
    } finally { h.events.dispose(); }
  });

  it.each(["cancel", "settle", "resolved"] as const)("retires buffered approvals on %s", (edge) => {
    const h = interactionHarness();
    try {
      h.awaitStartResponse();
      h.events.handleServerRequest("early", "item/commandExecution/requestApproval", approvalParams());
      if (edge === "cancel") h.cancelRun();
      if (edge === "cancel" || edge === "settle") h.events.settleInteractions();
      else h.events.handleNotification("serverRequest/resolved", { requestId: "early" });
      h.receiveStartResponse(ROOT_TURN_ID);
      h.events.replayPreResponseTurnNotifications(ROOT_TURN_ID);
      expect(h.approvals).toEqual([]);
      expect(h.writes.some(({ result }) => (result as JsonObject)?.decision === "accept")).toBe(false);
    } finally { h.events.dispose(); }
  });

  it("keeps buffered request IDs reserved across startup", () => {
    const h = interactionHarness();
    try {
      h.awaitStartResponse();
      h.events.handleServerRequest("same-id", "item/commandExecution/requestApproval", approvalParams());
      h.events.handleServerRequest("same-id", "item/commandExecution/requestApproval", approvalParams(ROOT_THREAD_ID, "next-turn"));
      expect(h.cancel).toHaveBeenCalledWith("malformed-protocol");
      expect(h.approvals).toEqual([]);
      expect(h.writes).toEqual([]);
    } finally { h.events.dispose(); }
  });

  it("keeps a reused resolved request ID at its new position after turn completion", () => {
    const h = interactionHarness();
    try {
      h.awaitStartResponse();
      h.events.handleServerRequest("reused", "item/commandExecution/requestApproval", approvalParams());
      h.events.handleNotification("serverRequest/resolved", { requestId: "reused" });
      h.events.handleNotification("turn/started", {
        threadId: ROOT_THREAD_ID, turn: { id: ROOT_TURN_ID, status: "inProgress" },
      });
      h.events.handleNotification("turn/completed", {
        threadId: ROOT_THREAD_ID, turn: { id: ROOT_TURN_ID, status: "completed" },
      });
      h.events.handleServerRequest("reused", "item/commandExecution/requestApproval", approvalParams());
      h.receiveStartResponse(ROOT_TURN_ID);
      h.events.replayPreResponseTurnNotifications(ROOT_TURN_ID);
      expect(h.approvals).toEqual([]);
      expect(h.writes).toEqual([{ id: "reused", error: expect.any(Object) }]);
    } finally { h.events.dispose(); }
  });

  it.each(["child-turn", "other-turn"])("waits for an owned child's turn identity (%s)", (turnId) => {
    const h = interactionHarness();
    try {
      registerChild(h);
      h.events.handleServerRequest("child", "item/commandExecution/requestApproval", approvalParams("approval-child", "child-turn"));
      expect(h.approvals).toEqual([]);
      h.events.handleNotification("turn/started", { threadId: "approval-child", turn: { id: turnId, status: "inProgress" } });
      expect(h.approvals).toHaveLength(turnId === "child-turn" ? 1 : 0);
      if (turnId === "child-turn") {
        expect(h.events.respondToApproval(h.approvals[0]!.requestId, "approve")).toBe(true);
      } else {
        expect(h.writes).toEqual([{ id: "child", error: expect.objectContaining({ code: -32602 }) }]);
        expect(h.cancel).not.toHaveBeenCalled();
      }
    } finally { h.events.dispose(); }
  });

  it("refuses a previously displayed approval after its turn changes", () => {
    const h = interactionHarness();
    try {
      h.events.handleServerRequest("approval", "item/commandExecution/requestApproval", approvalParams());
      h.changeActiveTurn("next-turn");
      expect(h.events.respondToApproval(h.approvals[0]!.requestId, "approve")).toBe(true);
      expect(h.writes).toEqual([{ id: "approval", error: expect.any(Object) }]);
      expect(h.resolved).toEqual([[h.approvals[0]!.requestId, "cancelled"]]);
    } finally { h.events.dispose(); }
  });

  it("answers an approval that arrives after the user stops without a protocol failure", () => {
    const h = interactionHarness();
    try {
      h.cancelRun();
      h.events.handleServerRequest("late", "item/commandExecution/requestApproval", approvalParams());
      expect(h.approvals).toEqual([]);
      expect(h.writes).toEqual([{ id: "late", result: { decision: "cancel" } }]);
      expect(h.rememberFailure).not.toHaveBeenCalled();
      expect(h.cancel).not.toHaveBeenCalled();
    } finally { h.events.dispose(); }
  });

  it.each(["stop", "turn-completed"] as const)("retires a displayed approval answered after %s without a protocol failure", (edge) => {
    const h = interactionHarness();
    try {
      h.events.handleServerRequest("approval", "item/commandExecution/requestApproval", approvalParams());
      const { requestId } = h.approvals[0]!;
      if (edge === "stop") h.cancelRun();
      else h.events.handleNotification("turn/completed", { threadId: ROOT_THREAD_ID, turn: { id: ROOT_TURN_ID, status: "completed" } });
      expect(h.events.respondToApproval(requestId, "approve")).toBe(true);
      expect(h.writes).toEqual([edge === "stop"
        ? { id: "approval", result: { decision: "cancel" } }
        : { id: "approval", error: expect.objectContaining({ code: -32602 }) }]);
      expect(h.resolved).toEqual([[requestId, "cancelled"]]);
      expect(h.rememberFailure).not.toHaveBeenCalled();
      expect(h.cancel).not.toHaveBeenCalled();
      expect(h.events.respondToApproval(requestId, "approve")).toBe(false);
    } finally { h.events.dispose(); }
  });

  it.each([
    ["thread/closed", {}],
    ["error", { willRetry: false, error: { message: "Child exited" } }],
    ["thread/status/changed", { status: { type: "systemError" } }],
  ] as const)("does not restore approval authority after a child %s", (method, params) => {
    for (const delayedStart of [false, true]) {
      const h = interactionHarness();
      try {
        registerChild(h);
        const started = { threadId: "approval-child", turn: { id: "child-turn", status: "inProgress" } };
        h.events.handleNotification("turn/started", started);
        h.events.handleServerRequest("child-approval", "item/commandExecution/requestApproval", approvalParams("approval-child", "child-turn"));
        expect(h.approvals).toHaveLength(1);
        h.events.handleNotification(method, { ...params, threadId: "approval-child" });
        expect(h.resolved).toEqual([[h.approvals[0]!.requestId, "cancelled"]]);
        if (delayedStart) h.events.handleNotification("turn/started", started);
        expect(h.events.respondToApproval(h.approvals[0]!.requestId, "approve")).toBe(false);
        expect(h.writes.some(({ result }) => (result as JsonObject)?.decision === "accept")).toBe(false);
      } finally { h.events.dispose(); }
    }
  });

  it.each([
    ["thread/closed", {}],
    ["error", { willRetry: false, error: { message: "Child exited" } }],
    ["thread/status/changed", { status: { type: "systemError" } }],
  ] as const)("allows a fresh child turn after %s while keeping its old turn retired", (method, params) => {
    const h = interactionHarness();
    try {
      registerChild(h);
      h.events.handleNotification("turn/started", { threadId: "approval-child", turn: { id: "child-turn", status: "inProgress" } });
      h.events.handleNotification(method, { ...params, threadId: "approval-child" });
      h.events.handleNotification("turn/started", { threadId: "approval-child", turn: { id: "resumed-turn", status: "inProgress" } });
      h.events.handleNotification("turn/started", { threadId: "approval-child", turn: { id: "child-turn", status: "inProgress" } });
      h.events.handleServerRequest("fresh-approval", "item/commandExecution/requestApproval", approvalParams("approval-child", "resumed-turn"));
      expect(h.approvals).toHaveLength(1);
      expect(h.events.respondToApproval(h.approvals[0]!.requestId, "approve")).toBe(true);
      expect(h.writes).toEqual([{ id: "fresh-approval", result: { decision: "accept" } }]);
      expect(h.cancel).not.toHaveBeenCalled();
    } finally { h.events.dispose(); }
  });

  it("rejects an approval for a completed child turn without waiting or resurfacing it", () => {
    const h = interactionHarness();
    try {
      registerChild(h);
      h.events.handleNotification("turn/completed", { threadId: "approval-child", turn: { id: "child-turn", status: "completed" } });
      h.events.handleServerRequest("child", "item/commandExecution/requestApproval", approvalParams("approval-child", "child-turn"));
      expect(h.approvals).toEqual([]);
      expect(h.writes).toEqual([{ id: "child", error: expect.any(Object) }]);
      expect(h.cancel).not.toHaveBeenCalled();
    } finally { h.events.dispose(); }
  });

  it("forgets the oldest child turn at the history limit without reviving retired approvals", () => {
    const h = interactionHarness();
    try {
      registerChild(h);
      h.events.handleNotification("turn/started", { threadId: "approval-child", turn: { id: "original-turn", status: "inProgress" } });
      h.events.handleServerRequest("old-approval", "item/commandExecution/requestApproval", approvalParams("approval-child", "original-turn"));
      h.events.handleNotification("thread/closed", { threadId: "approval-child" });
      expect(h.resolved).toEqual([[h.approvals[0]!.requestId, "cancelled"]]);
      for (let index = 0; index < 1_024; index += 1) {
        const turn = { id: `fresh-${index}`, status: "inProgress" };
        h.events.handleNotification("turn/started", { threadId: "approval-child", turn });
        h.events.handleNotification("turn/completed", { threadId: "approval-child", turn: { ...turn, status: "completed" } });
      }
      expect(h.cancel).not.toHaveBeenCalled();
      expect(h.rememberFailure).not.toHaveBeenCalled();
      h.events.handleNotification("turn/started", { threadId: "approval-child", turn: { id: "original-turn", status: "inProgress" } });
      expect(h.events.respondToApproval(h.approvals[0]!.requestId, "approve")).toBe(false);
      expect(h.writes.some(({ result }) => (result as JsonObject)?.decision === "accept")).toBe(false);
    } finally { h.events.dispose(); }
  });

  it("counts deferred approvals toward the existing pending request limit", () => {
    const h = interactionHarness();
    try {
      h.awaitStartResponse();
      for (let index = 0; index < 33; index += 1) {
        h.events.handleServerRequest(`approval-${index}`, "item/commandExecution/requestApproval", approvalParams());
      }
      expect(h.approvals).toEqual([]);
      expect(h.writes).toEqual([{ id: "approval-32", error: expect.objectContaining({ code: -32600 }) }]);
      expect(h.cancel).toHaveBeenCalledOnce();
    } finally { h.events.dispose(); }
  });

  it("bounds the wait for a child's turn without granting an unknown owner", () => {
    vi.useFakeTimers();
    const h = interactionHarness();
    try {
      registerChild(h);
      h.events.handleServerRequest("child", "item/commandExecution/requestApproval", approvalParams("approval-child", "child-turn"));
      vi.advanceTimersByTime(30_000);
      expect(h.approvals).toEqual([]);
      expect(h.writes).toEqual([{ id: "child", error: expect.any(Object) }]);
      expect(h.cancel).not.toHaveBeenCalled();
    } finally { h.events.dispose(); vi.useRealTimers(); }
  });

  it("preserves the legacy thread-only approval contract", () => {
    const h = interactionHarness();
    try {
      h.events.handleServerRequest("legacy", "execCommandApproval", {
        conversationId: ROOT_THREAD_ID, callId: "legacy-call", command: ["npm", "test"], cwd: "/workspace",
      });
      expect(h.events.respondToApproval(h.approvals[0]!.requestId, "approve")).toBe(true);
      expect(h.writes).toEqual([{ id: "legacy", result: { decision: "approved" } }]);
    } finally { h.events.dispose(); }
  });
});

describe("Codex App Server interaction ownership", () => {
  it("answers current-time reads only for an owned provider thread", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-15T08:00:00.900Z"));
    try {
      const owned = interactionHarness();
      try {
        owned.events.handleServerRequest(
          "current-time",
          "currentTime/read",
          { threadId: ROOT_THREAD_ID },
        );
        expect(owned.writes).toEqual([{
          id: "current-time",
          result: { currentTimeAt: 1_800_000_000 },
        }]);
        expect(owned.cancel).not.toHaveBeenCalled();
      } finally {
        owned.events.dispose();
      }

      const foreign = interactionHarness();
      try {
        foreign.events.handleServerRequest(
          "foreign-current-time",
          "currentTime/read",
          { threadId: "foreign-thread" },
        );
        expect(foreign.writes).toContainEqual({
          id: "foreign-current-time",
          error: expect.objectContaining({ code: -32602 }),
        });
        expect(foreign.cancel).toHaveBeenCalledOnce();
      } finally {
        foreign.events.dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("declines owned MCP elicitation without pretending question parity", () => {
    const harness = interactionHarness();
    try {
      harness.events.handleServerRequest(
        "mcp-elicitation",
        "mcpServer/elicitation/request",
        {
          threadId: ROOT_THREAD_ID,
          turnId: ROOT_TURN_ID,
          serverName: "example-mcp",
          mode: "form",
          message: "Enter a constrained value",
          requestedSchema: {
            type: "object",
            properties: { count: { type: "integer", minimum: 1 } },
          },
          _meta: null,
        },
      );

      expect(harness.inputs).toEqual([]);
      expect(harness.writes).toContainEqual({
        id: "mcp-elicitation",
        result: { action: "decline", content: null, _meta: null },
      });
      expect(harness.cancel).not.toHaveBeenCalled();
    } finally {
      harness.events.dispose();
    }
  });

  it("rejects MCP elicitation outside the exact owned provider turn", () => {
    const harness = interactionHarness();
    try {
      harness.events.handleServerRequest(
        "foreign-mcp-elicitation",
        "mcpServer/elicitation/request",
        {
          threadId: ROOT_THREAD_ID,
          turnId: "foreign-turn",
          serverName: "example-mcp",
          mode: "url",
          message: "Open the authorization page",
          url: "https://example.test/authorize",
          elicitationId: "elicitation-1",
          _meta: null,
        },
      );

      expect(harness.writes).toContainEqual({
        id: "foreign-mcp-elicitation",
        error: expect.objectContaining({ code: -32602 }),
      });
      expect(harness.cancel).toHaveBeenCalledOnce();
    } finally {
      harness.events.dispose();
    }
  });

  it.each([
    ["foreign-thread", ROOT_TURN_ID],
    [ROOT_THREAD_ID, "foreign-turn"],
  ])("rejects user input outside the owned turn: %s/%s", (threadId, turnId) => {
    const harness = interactionHarness();
    try {
      harness.events.handleServerRequest(
        "foreign-input",
        "item/tool/requestUserInput",
        inputParams(threadId, turnId),
      );

      expect(harness.inputs).toEqual([]);
      expect(harness.writes).toContainEqual({
        id: "foreign-input",
        error: {
          code: -32602,
          message: "Codex sent a user-input request for a different provider turn.",
        },
      });
      expect(harness.cancel).toHaveBeenCalledOnce();
    } finally {
      harness.events.dispose();
    }
  });

  it("accepts input only for the exact active turn of an owned child", () => {
    const harness = interactionHarness();
    try {
      harness.events.handleNotification("item/completed", {
        threadId: ROOT_THREAD_ID,
        turnId: ROOT_TURN_ID,
        item: {
          type: "subAgentActivity",
          id: "child-call",
          kind: "started",
          agentThreadId: "input-child",
          agentPath: "/root/input-child",
        },
      });
      harness.events.handleNotification("turn/started", {
        threadId: "input-child",
        turn: { id: "input-child-turn", status: "inProgress" },
      });
      harness.events.handleServerRequest(
        "child-input",
        "item/tool/requestUserInput",
        inputParams("input-child", "input-child-turn"),
      );

      expect(harness.inputs).toHaveLength(1);
      expect(harness.cancel).not.toHaveBeenCalled();
    } finally {
      harness.events.dispose();
    }
  });

  it("fails closed when a pending server request id is reused", () => {
    const harness = interactionHarness();
    try {
      harness.events.handleServerRequest(
        "duplicate-id",
        "item/tool/requestUserInput",
        inputParams(),
      );
      harness.events.handleServerRequest(
        "duplicate-id",
        "item/tool/requestUserInput",
        inputParams(ROOT_THREAD_ID, ROOT_TURN_ID, "second-item"),
      );

      expect(harness.inputs).toHaveLength(1);
      expect(harness.cancel).toHaveBeenCalledOnce();
      expect(harness.rememberFailure).toHaveBeenCalledWith(
        "malformed-protocol",
        "Codex sent an ambiguous server request.",
        "Codex reused an outstanding JSON-RPC request id.",
      );
      expect(harness.writes).toEqual([]);
    } finally {
      harness.events.dispose();
    }
  });

  it("bounds concurrent server requests and releases resolved ids", () => {
    const harness = interactionHarness();
    try {
      harness.events.handleServerRequest(
        "reusable-id",
        "item/tool/requestUserInput",
        inputParams(),
      );
      harness.events.handleNotification("serverRequest/resolved", {
        requestId: "reusable-id",
      });
      harness.events.handleServerRequest(
        "reusable-id",
        "item/tool/requestUserInput",
        inputParams(ROOT_THREAD_ID, ROOT_TURN_ID, "replacement-item"),
      );
      for (let index = 0; index < 31; index += 1) {
        harness.events.handleServerRequest(
          `bounded-${index}`,
          "item/tool/requestUserInput",
          inputParams(ROOT_THREAD_ID, ROOT_TURN_ID, `item-${index}`),
        );
      }
      harness.events.handleServerRequest(
        "overflow-request",
        "item/tool/requestUserInput",
        inputParams(ROOT_THREAD_ID, ROOT_TURN_ID, "overflow-item"),
      );

      expect(harness.inputs).toHaveLength(33);
      expect(harness.cancel).toHaveBeenCalledOnce();
      expect(harness.writes).toContainEqual({
        id: "overflow-request",
        error: {
          code: -32600,
          message: "Codex exceeded the 32-request interaction limit.",
        },
      });
    } finally {
      harness.events.dispose();
    }
  });
});
