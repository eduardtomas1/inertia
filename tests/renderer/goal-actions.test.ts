import { describe, expect, it } from "vitest";

import { nextGoalActions } from "../../src/renderer/src/utils/goalActions";
import type { AgentGoal } from "../../src/shared/contracts";

function goal(
  source: AgentGoal["source"],
  status: AgentGoal["status"],
): AgentGoal {
  return {
    conversationId: "30303030-3030-4030-8030-303030303030",
    source,
    providerSessionId: source === "codex-native" ? "thread-1" : null,
    objective: "Ship the release",
    status,
    tokenBudget: null,
    tokensUsed: null,
    timeUsedSeconds: null,
    createdAt: "2026-08-08T10:00:00.000Z",
    updatedAt: "2026-08-08T10:00:00.000Z",
    synchronizedAt: null,
  };
}

describe("goal actions", () => {
  it("offers the status transitions allowed from each goal state", () => {
    expect(nextGoalActions(goal("inertia-local", "active"), "idle")).toEqual([
      { label: "Pause", status: "paused", icon: "pause" },
      { label: "Block", status: "blocked", icon: "block" },
      { label: "Complete", status: "complete", icon: "complete" },
    ]);
    expect(nextGoalActions(goal("codex-native", "active"), "running"))
      .toHaveLength(3);
    expect(nextGoalActions(goal("codex-native", "active"), "idle")).toEqual([
      { label: "Resume goal", status: "active", icon: "play" },
    ]);
    expect(nextGoalActions(goal("inertia-local", "complete"), "idle")).toEqual([
      { label: "Reopen goal", status: "active", icon: "play" },
    ]);
    expect(nextGoalActions(goal("codex-native", "paused"), "idle")).toEqual([
      { label: "Mark active", status: "active", icon: "play" },
    ]);
    expect(nextGoalActions(goal("codex-native", "budgetLimited"), "idle"))
      .toEqual([]);
  });
});
