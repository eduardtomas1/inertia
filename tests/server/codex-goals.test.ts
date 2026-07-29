import { describe, expect, it } from "vitest";

import {
  parseCodexGoalClearedNotification,
  parseCodexGoalUpdatedNotification,
} from "../../src/server/codex/goals";

describe("Codex native goal notifications", () => {
  const goal = {
    threadId: "thread-1",
    objective: "Finish the migration",
    status: "active",
    tokenBudget: 40_000,
    tokensUsed: 1_250,
    timeUsedSeconds: 42,
    createdAt: 1_800_000_000,
    updatedAt: 1_800_000_010,
  };

  it("projects a schema-valid goal into the provider-neutral shape", () => {
    expect(parseCodexGoalUpdatedNotification({
      threadId: "thread-1",
      turnId: null,
      goal,
    })).toEqual({
      threadId: "thread-1",
      goal: {
        objective: "Finish the migration",
        status: "active",
        tokenBudget: 40_000,
        tokensUsed: 1_250,
        timeUsedSeconds: 42,
        createdAt: "2027-01-15T08:00:00.000Z",
        updatedAt: "2027-01-15T08:00:10.000Z",
      },
    });
    expect(parseCodexGoalClearedNotification({
      threadId: "thread-1",
    })).toBe("thread-1");
  });

  it("rejects malformed or internally mismatched goal payloads", () => {
    expect(parseCodexGoalUpdatedNotification({
      threadId: "thread-1",
      goal: { ...goal, threadId: "thread-2" },
    })).toBeNull();
    expect(parseCodexGoalUpdatedNotification({
      threadId: "thread-1",
      goal: { ...goal, status: "invented" },
    })).toBeNull();
    expect(parseCodexGoalUpdatedNotification({
      threadId: "thread-1",
      goal: { ...goal, objective: " " },
    })).toBeNull();
    expect(parseCodexGoalUpdatedNotification({
      threadId: "thread-1",
      goal: { ...goal, tokensUsed: -1 },
    })).toBeNull();
    expect(parseCodexGoalUpdatedNotification({
      threadId: "thread-1",
      goal: { ...goal, createdAt: "yesterday" },
    })).toBeNull();
    expect(parseCodexGoalUpdatedNotification({
      threadId: "thread-1",
      goal: {
        ...goal,
        createdAt: goal.updatedAt + 1,
      },
    })).toBeNull();
    expect(parseCodexGoalUpdatedNotification({
      threadId: "thread-1",
    })).toBeNull();
    expect(parseCodexGoalClearedNotification({
      threadId: "\0thread-1",
    })).toBeNull();
  });
});
