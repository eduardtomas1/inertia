// @inertia-test-suite portable
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodexAppServerEvents,
  type CodexAppServerEventHost,
} from "../../src/server/codex/app-server-events";
import { CODEX_RPC_TIMEOUT_MS, type CodexRunPhase } from "../../src/server/codex/app-server-config";
import { CappedTextBuffer, type JsonObject } from "../../src/server/codex/protocol";
import type { AgentApprovalRequest } from "../../src/server/provider/interactions";

const ROOT_THREAD_ID = "history-root";
const ROOT_TURN_ID = "history-turn";

function harness() {
  let phase: CodexRunPhase = "running";
  let activeTurnId: string | undefined = ROOT_TURN_ID;
  let cancelled = false;
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
      prompt: "Exercise delegated turn history",
      planMode: false,
      access: "full",
      onApproval: (request) => approvals.push(request),
      onApprovalResolved: (requestId, decision) => resolved.push([requestId, decision]),
    },
    resultText: new CappedTextBuffer(1_024),
    isSettled: () => phase === "settled",
    phase: () => phase,
    setPhase: (value) => { phase = value; },
    providerThreadId: () => ROOT_THREAD_ID,
    activeTurnId: () => activeTurnId,
    requestedTurnId: () => undefined,
    setActiveTurnId: (value) => { activeTurnId = value; },
    cancelRequested: () => cancelled,
    lastError: () => undefined,
    setLastError: vi.fn(),
    setLastProtocolMethod: vi.fn(),
    setLastActivityId: vi.fn(),
    setTerminalEvent: vi.fn(),
    writeMessage: (message) => { writes.push(message); return true; },
    cancel,
    finish: vi.fn(),
    rememberFailure,
  };
  return {
    events: new CodexAppServerEvents(host),
    approvals,
    resolved,
    writes,
    cancel,
    rememberFailure,
    cancelRun: () => { cancelled = true; },
  };
}

type Harness = ReturnType<typeof harness>;

function registerChild(h: Harness, child: string): void {
  h.events.handleNotification("item/completed", {
    threadId: ROOT_THREAD_ID,
    turnId: ROOT_TURN_ID,
    item: {
      type: "subAgentActivity", id: `spawn-${child}`, kind: "started",
      agentThreadId: child, agentPath: `/root/${child}`,
    },
  });
}

function startTurn(h: Harness, threadId: string, turnId: string): void {
  h.events.handleNotification("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
}

function completeTurn(h: Harness, threadId: string, turnId: string): void {
  h.events.handleNotification("turn/completed", { threadId, turn: { id: turnId, status: "completed" } });
}

function approval(threadId: string, turnId: string, itemId: string): JsonObject {
  return { threadId, turnId, itemId, startedAtMs: 1, command: "npm test", cwd: "/workspace" };
}

function expectRunAlive(h: Harness): void {
  expect(h.cancel).not.toHaveBeenCalled();
  expect(h.rememberFailure).not.toHaveBeenCalled();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Codex delegated-agent turn history", () => {
  it("keeps a long delegated run alive past the history limit with its live approval intact", () => {
    const h = harness();
    try {
      const workers = Array.from({ length: 8 }, (_, index) => `worker-${index}`);
      for (const worker of workers) registerChild(h, worker);
      registerChild(h, "reviewer");
      startTurn(h, "reviewer", "review-live");
      h.events.handleServerRequest("live-approval", "item/commandExecution/requestApproval", approval("reviewer", "review-live", "cmd-live"));
      expect(h.approvals).toHaveLength(1);
      for (let round = 0; round < 140; round += 1) {
        for (const worker of workers) {
          startTurn(h, worker, `${worker}-task-${round}`);
          completeTurn(h, worker, `${worker}-task-${round}`);
        }
      }
      expectRunAlive(h);
      expect(h.resolved).toEqual([]);
      expect(h.events.respondToApproval(h.approvals[0]!.requestId, "approve")).toBe(true);
      expect(h.writes).toEqual([{ id: "live-approval", result: { decision: "accept" } }]);
    } finally { h.events.dispose(); }
  });

  it.each([
    ["turn/completed", { turn: { id: "turn-a", status: "completed" } }],
    ["error", { willRetry: false, error: { message: "Child failed" } }],
    ["thread/closed", {}],
    ["thread/status/changed", { status: { type: "systemError" } }],
  ] as const)("cancels a displayed approval when its child turn retires through %s", (method, params) => {
    const h = harness();
    try {
      registerChild(h, "child");
      startTurn(h, "child", "turn-a");
      h.events.handleServerRequest("pending", "item/commandExecution/requestApproval", approval("child", "turn-a", "cmd-a"));
      const { requestId } = h.approvals[0]!;
      h.events.handleNotification(method, { ...params, threadId: "child" });
      expect(h.resolved).toEqual([[requestId, "cancelled"]]);
      expect(h.writes).toEqual([{ id: "pending", error: expect.objectContaining({ code: -32602 }) }]);
      expect(h.events.respondToApproval(requestId, "approve")).toBe(false);
      expectRunAlive(h);
    } finally { h.events.dispose(); }
  });

  it("keeps an approval for another child turn when one child turn retires", () => {
    const h = harness();
    try {
      registerChild(h, "first");
      registerChild(h, "second");
      startTurn(h, "first", "first-turn");
      startTurn(h, "second", "second-turn");
      h.events.handleServerRequest("second-approval", "item/commandExecution/requestApproval", approval("second", "second-turn", "cmd-second"));
      completeTurn(h, "first", "first-turn");
      expect(h.resolved).toEqual([]);
      expect(h.events.respondToApproval(h.approvals[0]!.requestId, "approve")).toBe(true);
      expect(h.writes).toEqual([{ id: "second-approval", result: { decision: "accept" } }]);
    } finally { h.events.dispose(); }
  });

  it.each(["turn-unknown", "turn-retired"])("refuses an approval for a non-active child turn without failing the run (%s)", (turnId) => {
    const h = harness();
    try {
      registerChild(h, "child");
      startTurn(h, "child", "turn-retired");
      completeTurn(h, "child", "turn-retired");
      startTurn(h, "child", "turn-current");
      h.events.handleServerRequest("stale", "item/commandExecution/requestApproval", approval("child", turnId, "cmd-stale"));
      expect(h.approvals).toEqual([]);
      expect(h.writes).toEqual([{ id: "stale", error: expect.objectContaining({ code: -32602 }) }]);
      expectRunAlive(h);
    } finally { h.events.dispose(); }
  });

  it("refuses an approval for an evicted child turn and keeps the run", () => {
    const h = harness();
    try {
      registerChild(h, "child");
      registerChild(h, "worker");
      startTurn(h, "child", "turn-evicted");
      completeTurn(h, "child", "turn-evicted");
      for (let index = 0; index < 1_024; index += 1) {
        startTurn(h, "worker", `worker-${index}`);
        completeTurn(h, "worker", `worker-${index}`);
      }
      startTurn(h, "child", "turn-current");
      h.events.handleServerRequest("evicted", "item/commandExecution/requestApproval", approval("child", "turn-evicted", "cmd-evicted"));
      expect(h.approvals).toEqual([]);
      expect(h.writes).toEqual([{ id: "evicted", error: expect.objectContaining({ code: -32602 }) }]);
      expectRunAlive(h);
    } finally { h.events.dispose(); }
  });

  it("refuses a deferred child approval at the owner-wait timeout without failing the run", () => {
    vi.useFakeTimers();
    const h = harness();
    try {
      registerChild(h, "child");
      h.events.handleServerRequest("deferred", "item/commandExecution/requestApproval", approval("child", "turn-later", "cmd-later"));
      expect(h.writes).toEqual([]);
      vi.advanceTimersByTime(CODEX_RPC_TIMEOUT_MS);
      expect(h.approvals).toEqual([]);
      expect(h.writes).toEqual([{ id: "deferred", error: expect.objectContaining({ code: -32602 }) }]);
      expectRunAlive(h);
    } finally { h.events.dispose(); }
  });

  it("answers deferred approvals with the cancel result when interactions settle", () => {
    const h = harness();
    try {
      registerChild(h, "child");
      h.events.handleServerRequest("deferred", "item/commandExecution/requestApproval", approval("child", "turn-later", "cmd-d"));
      h.events.handleServerRequest("displayed", "item/commandExecution/requestApproval", approval(ROOT_THREAD_ID, ROOT_TURN_ID, "cmd-r"));
      h.events.settleInteractions();
      expect(h.writes).toEqual(expect.arrayContaining([
        { id: "deferred", result: { decision: "cancel" } },
        { id: "displayed", result: { decision: "cancel" } },
      ]));
      expect(h.writes).toHaveLength(2);
    } finally { h.events.dispose(); }
  });

  it.each([
    ["item/commandExecution/requestApproval", { command: "npm test", cwd: "/workspace" }, { decision: "cancel" }],
    ["item/permissions/requestApproval", { permissions: { network: { enabled: true } } }, { permissions: {}, scope: "turn" }],
  ] as const)("answers %s after the user stops with the protocol's cancel result", (method, details, result) => {
    const h = harness();
    try {
      h.events.handleServerRequest("displayed", method, { threadId: ROOT_THREAD_ID, turnId: ROOT_TURN_ID, itemId: "item-1", ...details });
      h.cancelRun();
      h.events.handleServerRequest("late", method, { threadId: ROOT_THREAD_ID, turnId: ROOT_TURN_ID, itemId: "item-2", ...details });
      expect(h.events.respondToApproval(h.approvals[0]!.requestId, "approve")).toBe(true);
      expect(h.writes).toEqual([{ id: "late", result }, { id: "displayed", result }]);
      expect(h.rememberFailure).not.toHaveBeenCalled();
    } finally { h.events.dispose(); }
  });
});
