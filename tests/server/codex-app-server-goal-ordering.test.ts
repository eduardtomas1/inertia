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

function failedTurn(): JsonObject {
  return {
    threadId: THREAD_ID,
    turn: {
      id: TURN_ID,
      status: "failed",
      items: [],
      error: { message: "Provider turn failed" },
    },
  };
}

function eventHarness(options: { goalContinuationExpected?: boolean } = {}) {
  let phase: CodexRunPhase = "running";
  let activeTurnId: string | undefined = TURN_ID;
  const goalStatuses: AgentGoalStatus[] = [];
  const goalClears: string[] = [];
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
      goalContinuationExpected: options.goalContinuationExpected ?? true,
      goalContinuationGraceMs: 25,
      subagentDrainTimeoutMs: 25,
      onGoalUpdated: (_threadId, goal) => {
        goalStatuses.push(goal.status);
      },
      onGoalCleared: (threadId) => goalClears.push(threadId),
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
    goalClears,
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

  it("keeps the run alive while a goal activation response is pending", () => {
    vi.useFakeTimers();
    const harness = eventHarness({ goalContinuationExpected: false });
    try {
      harness.events.beginGoalMutation(true);
      harness.events.handleNotification("turn/completed", completedTurn());

      expect(harness.phase()).toBe("awaiting-goal-continuation");
      vi.advanceTimersByTime(100);
      expect(harness.finish).not.toHaveBeenCalled();

      const sequenceAtResponse = harness.events.goalProjectionSequence();
      expect(harness.events.projectGoalResponse(
        THREAD_ID,
        goalUpdate("active", 1_800_000_010).goal,
        sequenceAtResponse,
      )).toMatchObject({ status: "active" });
      harness.events.endGoalMutation(true);
      harness.events.handleNotification("turn/started", {
        threadId: THREAD_ID,
        turn: {
          id: "turn-after-activation",
          status: "inProgress",
          items: [],
          error: null,
        },
      });

      expect(harness.phase()).toBe("running");
      expect(harness.activeTurnId()).toBe("turn-after-activation");
      expect(harness.finish).not.toHaveBeenCalled();
    } finally {
      harness.events.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps a terminal goal mutation alive through its response", () => {
    vi.useFakeTimers();
    const harness = eventHarness();
    try {
      harness.events.handleNotification(
        "thread/goal/updated",
        goalUpdate("active", 1_800_000_010),
      );
      harness.events.handleNotification("turn/completed", completedTurn());
      harness.events.beginGoalMutation(false);
      harness.events.handleNotification(
        "thread/goal/updated",
        goalUpdate("complete", 1_800_000_011),
      );

      vi.advanceTimersByTime(100);
      expect(harness.finish).not.toHaveBeenCalled();

      const sequenceAtResponse = harness.events.goalProjectionSequence();
      expect(harness.events.projectGoalResponse(
        THREAD_ID,
        goalUpdate("complete", 1_800_000_011).goal,
        sequenceAtResponse,
      )).toMatchObject({ status: "complete" });
      expect(harness.finish).not.toHaveBeenCalled();

      harness.events.endGoalMutation(false);

      expect(harness.finish).toHaveBeenCalledOnce();
      expect(harness.finish).toHaveBeenCalledWith("completed", 0, null);
    } finally {
      harness.events.dispose();
      vi.useRealTimers();
    }
  });

  it("projects a goal response before settling a failed parent turn", () => {
    const harness = eventHarness({ goalContinuationExpected: false });
    try {
      harness.events.beginGoalMutation(true);
      harness.events.handleNotification("turn/completed", failedTurn());

      expect(harness.finish).not.toHaveBeenCalled();

      const sequenceAtResponse = harness.events.goalProjectionSequence();
      expect(harness.events.projectGoalResponse(
        THREAD_ID,
        goalUpdate("active", 1_800_000_010).goal,
        sequenceAtResponse,
      )).toMatchObject({ status: "active" });
      expect(harness.finish).not.toHaveBeenCalled();

      harness.events.endGoalMutation(true);

      expect(harness.goalStatuses).toEqual(["active"]);
      expect(harness.finish).toHaveBeenCalledOnce();
      expect(harness.finish).toHaveBeenCalledWith("failed", 1, null);
    } finally {
      harness.events.dispose();
    }
  });

  it("keeps a goal clear alive through its response", () => {
    vi.useFakeTimers();
    const harness = eventHarness();
    try {
      harness.events.handleNotification(
        "thread/goal/updated",
        goalUpdate("active", 1_800_000_010),
      );
      harness.events.handleNotification("turn/completed", completedTurn());
      harness.events.beginGoalMutation(false);
      harness.events.handleNotification("thread/goal/cleared", {
        threadId: THREAD_ID,
      });

      vi.advanceTimersByTime(100);
      expect(harness.finish).not.toHaveBeenCalled();

      const sequenceAtResponse = harness.events.goalProjectionSequence();
      expect(harness.events.projectGoalClearResponse(
        THREAD_ID,
        sequenceAtResponse,
      )).toBe(true);
      expect(harness.finish).not.toHaveBeenCalled();

      harness.events.endGoalMutation(false);

      expect(harness.finish).toHaveBeenCalledOnce();
      expect(harness.finish).toHaveBeenCalledWith("completed", 0, null);
    } finally {
      harness.events.dispose();
      vi.useRealTimers();
    }
  });

  it("cancels deferred completion when a goal activation begins", () => {
    vi.useFakeTimers();
    const harness = eventHarness();
    try {
      harness.events.handleNotification(
        "thread/goal/updated",
        goalUpdate("active", 1_800_000_010),
      );
      harness.events.handleNotification("item/started", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: {
          id: "spawn-before-reactivation",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "inProgress",
          senderThreadId: THREAD_ID,
          receiverThreadIds: ["child-before-reactivation"],
          prompt: "Keep checking",
          agentsStates: {
            "child-before-reactivation": {
              status: "running",
              message: "Still checking",
            },
          },
        },
      });
      harness.events.handleNotification("turn/completed", completedTurn());
      vi.advanceTimersByTime(25);
      expect(harness.finish).not.toHaveBeenCalled();

      harness.events.beginGoalMutation(true);
      vi.advanceTimersByTime(100);
      expect(harness.finish).not.toHaveBeenCalled();

      const sequenceAtResponse = harness.events.goalProjectionSequence();
      expect(harness.events.projectGoalResponse(
        THREAD_ID,
        goalUpdate("active", 1_800_000_011).goal,
        sequenceAtResponse,
      )).toMatchObject({ status: "active" });
      harness.events.endGoalMutation(true);
      harness.events.handleNotification("turn/started", {
        threadId: THREAD_ID,
        turn: {
          id: "turn-after-reactivation",
          status: "inProgress",
          items: [],
          error: null,
        },
      });
      vi.advanceTimersByTime(25);

      expect(harness.finish).not.toHaveBeenCalled();
      expect(harness.phase()).toBe("running");
      expect(harness.activeTurnId()).toBe("turn-after-reactivation");
    } finally {
      harness.events.dispose();
      vi.useRealTimers();
    }
  });

  it("transfers an ordinary deferred completion to a goal activation", () => {
    vi.useFakeTimers();
    const harness = eventHarness({ goalContinuationExpected: false });
    try {
      harness.events.handleNotification("item/started", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: {
          id: "spawn-before-first-activation",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "inProgress",
          senderThreadId: THREAD_ID,
          receiverThreadIds: ["child-before-first-activation"],
          prompt: "Keep checking",
          agentsStates: {
            "child-before-first-activation": {
              status: "running",
              message: "Still checking",
            },
          },
        },
      });
      harness.events.handleNotification("turn/completed", completedTurn());
      expect(harness.phase()).toBe("running");

      harness.events.beginGoalMutation(true);
      expect(harness.phase()).toBe("awaiting-goal-continuation");
      expect(harness.activeTurnId()).toBeUndefined();
      vi.advanceTimersByTime(100);
      expect(harness.finish).not.toHaveBeenCalled();

      const sequenceAtResponse = harness.events.goalProjectionSequence();
      expect(harness.events.projectGoalResponse(
        THREAD_ID,
        goalUpdate("active", 1_800_000_010).goal,
        sequenceAtResponse,
      )).toMatchObject({ status: "active" });
      harness.events.endGoalMutation(true);
      harness.events.handleNotification("turn/started", {
        threadId: THREAD_ID,
        turn: {
          id: "turn-after-first-activation",
          status: "inProgress",
          items: [],
          error: null,
        },
      });
      vi.advanceTimersByTime(25);

      expect(harness.finish).not.toHaveBeenCalled();
      expect(harness.phase()).toBe("running");
      expect(harness.activeTurnId()).toBe("turn-after-first-activation");
    } finally {
      harness.events.dispose();
      vi.useRealTimers();
    }
  });

  it("rejects an equal-revision replay after a later goal status", () => {
    const harness = eventHarness();
    try {
      harness.events.handleNotification(
        "thread/goal/updated",
        goalUpdate("active", 1_800_000_010),
      );
      harness.events.handleNotification(
        "thread/goal/updated",
        goalUpdate("complete", 1_800_000_010),
      );
      harness.events.handleNotification(
        "thread/goal/updated",
        goalUpdate("active", 1_800_000_010),
      );
      harness.events.handleNotification("turn/completed", completedTurn());

      expect(harness.goalStatuses).toEqual(["active", "complete"]);
      expect(harness.finish).toHaveBeenCalledWith("completed", 0, null);
    } finally {
      harness.events.dispose();
    }
  });

  it("rejects a continuation after the goal becomes terminal", () => {
    vi.useFakeTimers();
    const harness = eventHarness();
    try {
      harness.events.handleNotification(
        "thread/goal/updated",
        goalUpdate("active", 1_800_000_010),
      );
      harness.events.handleNotification("item/started", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: {
          id: "spawn-before-terminal-goal",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "inProgress",
          senderThreadId: THREAD_ID,
          receiverThreadIds: ["child-before-terminal-goal"],
          prompt: "Keep checking",
          agentsStates: {
            "child-before-terminal-goal": {
              status: "running",
              message: "Still checking",
            },
          },
        },
      });
      harness.events.handleNotification("turn/completed", completedTurn());
      harness.events.handleNotification(
        "thread/goal/updated",
        goalUpdate("complete", 1_800_000_010),
      );
      harness.events.handleNotification("turn/started", {
        threadId: THREAD_ID,
        turn: {
          id: "turn-after-terminal-goal",
          status: "inProgress",
          items: [],
          error: null,
        },
      });

      expect(harness.phase()).toBe("awaiting-goal-continuation");
      expect(harness.activeTurnId()).toBeUndefined();
      vi.advanceTimersByTime(25);
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

  it("lets an equal-revision response win over pre-response notifications", () => {
    const harness = eventHarness();
    try {
      harness.events.handleNotification(
        "thread/goal/updated",
        goalUpdate("active", 1_800_000_010),
      );
      const sequenceAtResponse = harness.events.goalProjectionSequence();
      const responseGoal = goalUpdate("paused", 1_800_000_010).goal;

      expect(harness.events.projectGoalResponse(
        THREAD_ID,
        responseGoal,
        sequenceAtResponse,
      )).toMatchObject({ status: "paused" });
      expect(harness.goalStatuses).toEqual(["active", "paused"]);
    } finally {
      harness.events.dispose();
    }
  });

  it("preserves a goal notification decoded after a clear response", () => {
    const harness = eventHarness();
    try {
      harness.events.handleNotification(
        "thread/goal/updated",
        goalUpdate("active", 1_800_000_010),
      );
      const sequenceAtResponse = harness.events.goalProjectionSequence();
      harness.events.handleNotification(
        "thread/goal/updated",
        goalUpdate("active", 1_800_000_011),
      );

      expect(harness.events.projectGoalClearResponse(
        THREAD_ID,
        sequenceAtResponse,
      )).toBe(false);
      expect(harness.goalClears).toEqual([]);
      expect(harness.goalStatuses).toEqual(["active", "active"]);
    } finally {
      harness.events.dispose();
    }
  });

  it("accepts a same-revision goal recreated after clear", () => {
    const harness = eventHarness();
    try {
      harness.events.handleNotification(
        "thread/goal/updated",
        goalUpdate("active", 1_800_000_010),
      );
      harness.events.handleNotification("thread/goal/cleared", {
        threadId: THREAD_ID,
      });
      harness.events.handleNotification(
        "thread/goal/updated",
        goalUpdate("active", 1_800_000_010),
      );

      expect(harness.goalClears).toEqual([THREAD_ID]);
      expect(harness.goalStatuses).toEqual(["active", "active"]);
    } finally {
      harness.events.dispose();
    }
  });

  it("cancels pending subagent-drain completion for a late continuation", () => {
    vi.useFakeTimers();
    const harness = eventHarness();
    try {
      harness.events.handleNotification(
        "thread/goal/updated",
        goalUpdate("active", 1_800_000_010),
      );
      harness.events.handleNotification("item/started", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: {
          id: "spawn-late-continuation",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "inProgress",
          senderThreadId: THREAD_ID,
          receiverThreadIds: ["child-late-continuation"],
          prompt: "Keep checking",
          agentsStates: {
            "child-late-continuation": {
              status: "running",
              message: "Still checking",
            },
          },
        },
      });
      harness.events.handleNotification("turn/completed", completedTurn());
      vi.advanceTimersByTime(25);
      expect(harness.finish).not.toHaveBeenCalled();

      harness.events.handleNotification("turn/started", {
        threadId: THREAD_ID,
        turn: {
          id: "turn-late-continuation",
          status: "inProgress",
          items: [],
          error: null,
        },
      });
      vi.advanceTimersByTime(25);

      expect(harness.finish).not.toHaveBeenCalled();
      expect(harness.phase()).toBe("running");
      expect(harness.activeTurnId()).toBe("turn-late-continuation");
    } finally {
      harness.events.dispose();
      vi.useRealTimers();
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
      request: (method, _params, onResponseFrame) => {
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
            onResponseFrame?.();
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
      beginGoalMutation: vi.fn(),
      endGoalMutation: vi.fn(),
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
