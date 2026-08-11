import { describe, expect, it, vi } from "vitest";

import {
  CodexAppServerEvents,
  type CodexAppServerEventHost,
} from "../../src/server/codex/app-server-events";
import {
  type CodexRunPhase,
} from "../../src/server/codex/app-server-config";
import { openCodexTurn } from "../../src/server/codex/app-server-run";
import { CappedTextBuffer, type JsonObject } from "../../src/server/codex/protocol";
import type { AgentGoalStatus } from "../../src/shared/contracts";

const THREAD_ID = "thread-goal-ordering";
const TURN_ID = "turn-goal-ordering";

function goalUpdate(
  status: AgentGoalStatus,
  updatedAt: number,
): JsonObject {
  return {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    goal: {
      threadId: THREAD_ID,
      objective: "Finish the ordered goal",
      status,
      tokenBudget: null,
      tokensUsed: 100,
      timeUsedSeconds: 1,
      createdAt: 1_800_000_000,
      updatedAt,
    },
  };
}

function completedTurn(): JsonObject {
  return {
    threadId: THREAD_ID,
    turn: {
      id: TURN_ID,
      status: "completed",
      items: [],
      error: null,
    },
  };
}

function eventHarness() {
  let phase: CodexRunPhase = "running";
  let activeTurnId: string | undefined = TURN_ID;
  const goalStatuses: AgentGoalStatus[] = [];
  const finish = vi.fn((status: "completed" | "failed" | "cancelled") => {
    phase = "settled";
    return status;
  });
  const host: CodexAppServerEventHost = {
    options: {
      executable: "/fake/codex",
      environment: {},
      cwd: "/workspace",
      prompt: "Continue the goal",
      planMode: false,
      access: "full",
      goalContinuationExpected: true,
      goalContinuationGraceMs: 25,
      onGoalUpdated: (_threadId, goal) => {
        goalStatuses.push(goal.status);
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
    setLastError: vi.fn(),
    setLastProtocolMethod: vi.fn(),
    setLastActivityId: vi.fn(),
    setTerminalEvent: vi.fn(),
    writeMessage: () => true,
    cancel: vi.fn(),
    finish,
    rememberFailure: vi.fn(),
  };
  const events = new CodexAppServerEvents(host);
  return {
    events,
    finish,
    goalStatuses,
    phase: () => phase,
    activeTurnId: () => activeTurnId,
  };
}

describe("Codex App Server goal event ordering", () => {
  it("does not let an older goal revision stop a newer active goal", () => {
    const harness = eventHarness();
    try {
      harness.events.handleNotification(
        "thread/goal/updated",
        goalUpdate("active", 1_800_000_010),
      );
      harness.events.handleNotification(
        "thread/goal/updated",
        goalUpdate("paused", 1_800_000_009),
      );
      harness.events.handleNotification("turn/completed", completedTurn());

      expect(harness.goalStatuses).toEqual(["active"]);
      expect(harness.phase()).toBe("awaiting-goal-continuation");
      expect(harness.activeTurnId()).toBeUndefined();
      expect(harness.finish).not.toHaveBeenCalled();
    } finally {
      harness.events.dispose();
    }
  });

  it("does not adopt a replayed completed turn as a continuation", () => {
    vi.useFakeTimers();
    const harness = eventHarness();
    try {
      harness.events.handleNotification(
        "thread/goal/updated",
        goalUpdate("active", 1_800_000_010),
      );
      harness.events.handleNotification("turn/completed", completedTurn());
      harness.events.handleNotification("turn/started", {
        threadId: THREAD_ID,
        turn: {
          id: TURN_ID,
          status: "inProgress",
          items: [],
          error: null,
        },
      });

      expect(harness.phase()).toBe("awaiting-goal-continuation");
      expect(harness.activeTurnId()).toBeUndefined();
      vi.advanceTimersByTime(25);
      expect(harness.finish).toHaveBeenCalledOnce();
      expect(harness.finish).toHaveBeenCalledWith("completed", 0, null);
    } finally {
      harness.events.dispose();
      vi.useRealTimers();
    }
  });

  it("does not let an equal-revision response revive a later notification", () => {
    const harness = eventHarness();
    try {
      const sequenceBeforeRequest = harness.events.goalProjectionSequence();
      harness.events.handleNotification(
        "thread/goal/updated",
        goalUpdate("complete", 1_800_000_010),
      );
      const responseGoal = goalUpdate("active", 1_800_000_010).goal;

      expect(harness.events.projectGoalResponse(
        THREAD_ID,
        responseGoal,
        sequenceBeforeRequest,
      )).toMatchObject({ status: "complete" });
      harness.events.handleNotification("turn/completed", completedTurn());

      expect(harness.goalStatuses).toEqual(["complete"]);
      expect(harness.finish).toHaveBeenCalledWith("completed", 0, null);
      expect(harness.phase()).toBe("settled");
    } finally {
      harness.events.dispose();
    }
  });

  it("preserves a goal phase advanced by notifications in the response chunk", async () => {
    let phase: CodexRunPhase = "opening";
    let activeTurnId: string | undefined;
    const statuses: string[] = [];

    await openCodexTurn({
      options: {
        executable: "/fake/codex",
        environment: {},
        cwd: "/workspace",
        prompt: "Continue the goal",
        sessionId: THREAD_ID,
        planMode: false,
        access: "full",
        goalContinuationExpected: true,
        onStatus: (status) => statuses.push(status),
      },
      modelProvider: undefined,
      request: (method) => {
        if (method === "initialize") {
          return Promise.resolve({ userAgent: "fake" });
        }
        if (method === "thread/resume") {
          return Promise.resolve({
            thread: { id: THREAD_ID },
            cwd: "/workspace",
            model: "fake",
          });
        }
        if (method === "turn/start") {
          return new Promise((resolve) => {
            resolve({
              turn: {
                id: TURN_ID,
                status: "inProgress",
                items: [],
                error: null,
              },
            });
            // The decoder can process subsequent notifications synchronously
            // before the resolved request resumes this async function.
            activeTurnId = undefined;
            phase = "awaiting-goal-continuation";
          });
        }
        return Promise.reject(new Error(`Unexpected request: ${method}`));
      },
      notify: vi.fn(),
      setProviderThreadId: vi.fn(),
      activeTurnId: () => activeTurnId,
      setActiveTurnId: (value) => {
        activeTurnId = value;
      },
      phase: () => phase,
      hasObservedTurn: (turnId) => turnId === TURN_ID,
      goalProjectionSequence: () => 0,
      projectGoalResponse: () => null,
      setContinuationError: vi.fn(),
      setPhase: (value) => {
        phase = value;
      },
      isSettled: () => false,
      isCancelRequested: () => false,
      finish: vi.fn(),
    });

    expect(phase).toBe("awaiting-goal-continuation");
    expect(activeTurnId).toBeUndefined();
    expect(statuses).toEqual([]);
  });
});
