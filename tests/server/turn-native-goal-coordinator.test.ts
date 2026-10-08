import { describe, expect, it, vi } from "vitest";

import { TurnNativeGoalCoordinator } from "../../src/server/runtime/turns/turn-native-goal-coordinator";

function activeTurn(tokenBudget: number | null | undefined, resolve: () => void, reject: (error: Error) => void) {
  return {
    sessionAfter: "thread-1",
    providerInput: {},
    conversation: {},
    turn: { harnessId: "codex-app-server" },
    nativeGoalStartAcknowledgement: {
      objective: "Ship it",
      ...(tokenBudget === undefined ? {} : { tokenBudget }),
      latestGoal: null,
      cleared: false,
      settlementQueued: false,
      resolve,
      reject,
    },
  };
}

function goalUpdated(tokenBudget: number | null) {
  return {
    type: "goal-updated",
    providerId: "codex",
    sessionId: "thread-1",
    goal: {
      objective: "Ship it",
      status: "active",
      tokenBudget,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
    },
  };
}

describe("native goal start acknowledgement", () => {
  it("accepts the budget Codex applies from its own config when the goal started without one", async () => {
    const coordinator = new TurnNativeGoalCoordinator({} as never);
    const resolve = vi.fn();
    const reject = vi.fn();
    const active = activeTurn(null, resolve, reject);
    coordinator.handleEvent(active as never, goalUpdated(500_000) as never);
    await Promise.resolve();
    coordinator.cleanup(active as never);
    expect(resolve).toHaveBeenCalledOnce();
    expect(reject).not.toHaveBeenCalled();
  });

  it("still waits for the exact budget the user chose", async () => {
    const coordinator = new TurnNativeGoalCoordinator({} as never);
    const resolve = vi.fn();
    const reject = vi.fn();
    const active = activeTurn(40_000, resolve, reject);
    coordinator.handleEvent(active as never, goalUpdated(500_000) as never);
    await Promise.resolve();
    expect(resolve).not.toHaveBeenCalled();
    coordinator.handleEvent(active as never, goalUpdated(40_000) as never);
    await Promise.resolve();
    coordinator.cleanup(active as never);
    expect(resolve).toHaveBeenCalledOnce();
    expect(reject).not.toHaveBeenCalled();
  });
});
