// @inertia-test-suite portable
import { describe, expect, it, vi } from "vitest";

import {
  CodexAppServerEvents,
  type CodexAppServerEventHost,
} from "../../src/server/codex/app-server-events";
import type { CodexRunPhase } from "../../src/server/codex/app-server-config";
import { CappedTextBuffer, type JsonObject } from "../../src/server/codex/protocol";

const THREAD_ID = "thread-subagent-continuation";
const ROOT_TURN_ID = "root-turn-1";
const CHILD_ID = "child-verifier";
const CHILD_TURN_ID = "child-turn-1";

function completedTurn(threadId: string, turnId: string): JsonObject {
  return {
    threadId,
    turn: {
      id: turnId,
      status: "completed",
      items: [],
      error: null,
    },
  };
}

function eventHarness() {
  let phase: CodexRunPhase = "running";
  let activeTurnId: string | undefined = ROOT_TURN_ID;
  const statuses: Array<{ status: string; providerState?: string }> = [];
  const finish = vi.fn((status: "completed" | "failed" | "cancelled") => {
    phase = "settled";
    return status;
  });
  const rememberFailure = vi.fn();
  const setLastError = vi.fn();
  const host: CodexAppServerEventHost = {
    options: {
      executable: "/fake/codex",
      environment: {},
      cwd: "/workspace",
      prompt: "Verify delegated work",
      planMode: false,
      access: "full",
      subagentDrainTimeoutMs: 25,
      onStatus: (status, providerState) => {
        statuses.push({ status, ...(providerState ? { providerState } : {}) });
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
    setActiveTurnId: (value) => {
      activeTurnId = value;
    },
    cancelRequested: () => false,
    lastError: () => undefined,
    setLastError,
    setLastProtocolMethod: vi.fn(),
    setLastActivityId: vi.fn(),
    setTerminalEvent: vi.fn(),
    writeMessage: () => true,
    cancel: vi.fn(),
    finish,
    rememberFailure,
  };
  const events = new CodexAppServerEvents(host);
  return {
    activeTurnId: () => activeTurnId,
    events,
    finish,
    phase: () => phase,
    rememberFailure,
    setLastError,
    statuses,
  };
}

function spawnLiveChild(events: CodexAppServerEvents): void {
  events.handleNotification("item/started", {
    threadId: THREAD_ID,
    turnId: ROOT_TURN_ID,
    item: {
      id: "spawn-verifier",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: THREAD_ID,
      receiverThreadIds: [CHILD_ID],
      prompt: "Verify the result",
      agentsStates: {
        [CHILD_ID]: {
          status: "running",
          message: "Still verifying",
        },
      },
    },
  });
  events.handleNotification("turn/started", {
    threadId: CHILD_ID,
    turn: {
      id: CHILD_TURN_ID,
      status: "inProgress",
      items: [],
      error: null,
    },
  });
}

describe("Codex App Server delegated continuation", () => {
  it("keeps a live child past the old drain and requires a fresh parent terminal", () => {
    vi.useFakeTimers();
    const harness = eventHarness();
    try {
      spawnLiveChild(harness.events);
      harness.events.handleNotification(
        "turn/completed",
        completedTurn(THREAD_ID, ROOT_TURN_ID),
      );

      expect(harness.phase()).toBe("awaiting-subagent-continuation");
      expect(harness.activeTurnId()).toBeUndefined();
      expect(harness.statuses).toContainEqual({
        status: "delegated",
        providerState: "awaiting delegated work and a fresh parent turn",
      });
      vi.advanceTimersByTime(100);
      expect(harness.finish).not.toHaveBeenCalled();

      harness.events.handleNotification(
        "turn/completed",
        completedTurn(CHILD_ID, CHILD_TURN_ID),
      );
      expect(harness.finish).not.toHaveBeenCalled();

      const continuationTurnId = "root-turn-2";
      harness.events.handleNotification("turn/started", {
        threadId: THREAD_ID,
        turn: {
          id: continuationTurnId,
          status: "inProgress",
          items: [],
          error: null,
        },
      });
      expect(harness.phase()).toBe("running");
      expect(harness.activeTurnId()).toBe(continuationTurnId);

      harness.events.handleNotification(
        "turn/completed",
        completedTurn(THREAD_ID, continuationTurnId),
      );
      expect(harness.finish).toHaveBeenCalledOnce();
      expect(harness.finish).toHaveBeenCalledWith("completed", 0, null);
    } finally {
      harness.events.dispose();
      vi.useRealTimers();
    }
  });

  it("fails closed when settled delegated work has no parent continuation", () => {
    vi.useFakeTimers();
    const harness = eventHarness();
    try {
      spawnLiveChild(harness.events);
      harness.events.handleNotification(
        "turn/completed",
        completedTurn(THREAD_ID, ROOT_TURN_ID),
      );
      harness.events.handleNotification(
        "turn/completed",
        completedTurn(CHILD_ID, CHILD_TURN_ID),
      );

      vi.advanceTimersByTime(24);
      expect(harness.finish).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);

      expect(harness.setLastError).toHaveBeenCalledWith(
        expect.stringContaining("did not resume"),
      );
      expect(harness.rememberFailure).toHaveBeenCalledWith(
        "codex-error",
        expect.stringContaining("did not resume"),
        expect.stringContaining("No fresh parent turn"),
      );
      expect(harness.finish).toHaveBeenCalledWith("failed", 1, null);
    } finally {
      harness.events.dispose();
      vi.useRealTimers();
    }
  });

  it("pauses an armed continuation grace when a late child becomes live", () => {
    vi.useFakeTimers();
    const harness = eventHarness();
    try {
      spawnLiveChild(harness.events);
      harness.events.handleNotification(
        "turn/completed",
        completedTurn(THREAD_ID, ROOT_TURN_ID),
      );
      harness.events.handleNotification(
        "turn/completed",
        completedTurn(CHILD_ID, CHILD_TURN_ID),
      );
      vi.advanceTimersByTime(24);

      const lateChildId = "late-child-verifier";
      harness.events.handleNotification("thread/started", {
        thread: {
          id: lateChildId,
          parentThreadId: THREAD_ID,
          agentNickname: "Late verifier",
        },
      });
      vi.advanceTimersByTime(100);
      expect(harness.finish).not.toHaveBeenCalled();

      harness.events.handleNotification(
        "turn/completed",
        completedTurn(lateChildId, "late-child-turn"),
      );
      harness.events.handleNotification("turn/started", {
        threadId: THREAD_ID,
        turn: {
          id: "root-turn-after-late-child",
          status: "inProgress",
          items: [],
          error: null,
        },
      });
      harness.events.handleNotification(
        "turn/completed",
        completedTurn(THREAD_ID, "root-turn-after-late-child"),
      );

      expect(harness.finish).toHaveBeenCalledWith("completed", 0, null);
    } finally {
      harness.events.dispose();
      vi.useRealTimers();
    }
  });

  it("discards the provisional terminal candidate during cancellation", () => {
    vi.useFakeTimers();
    const harness = eventHarness();
    try {
      spawnLiveChild(harness.events);
      harness.events.handleNotification(
        "turn/completed",
        completedTurn(THREAD_ID, ROOT_TURN_ID),
      );

      expect(harness.events.cancelPendingParentCompletion()).toBe(true);
      harness.events.handleNotification(
        "turn/completed",
        completedTurn(CHILD_ID, CHILD_TURN_ID),
      );
      vi.advanceTimersByTime(100);

      expect(harness.finish).not.toHaveBeenCalled();
      expect(harness.rememberFailure).not.toHaveBeenCalled();
    } finally {
      harness.events.dispose();
      vi.useRealTimers();
    }
  });
});
