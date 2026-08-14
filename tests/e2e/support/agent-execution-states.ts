import { expect, type Locator } from "@playwright/test";

import type { AgentActivity } from "../../../src/shared/contracts";

export async function verifyAgentExecutionStateSequence(input: {
  activeTurn: Locator;
  conversationId: string;
  runId: string;
  turnId: string;
  runningActivities: readonly AgentActivity[];
  activeAt: (seconds: number) => string;
  publish: (event: object) => Promise<void>;
  capture: (name: string, target: Locator) => Promise<void>;
}): Promise<void> {
  for (const activity of input.runningActivities) {
    await input.publish({
      type: "agent.activity",
      activity: { ...activity, status: "completed" },
    });
  }

  const searchActivity = {
    id: "activity-live-search",
    conversationId: input.conversationId,
    runId: input.runId,
    turnId: input.turnId,
    kind: "tool",
    title: "Search release documentation",
    detail: null,
    status: "running",
    createdAt: input.activeAt(18),
  } as const;
  await input.publish({ type: "agent.activity", activity: searchActivity });
  await expect(input.activeTurn.locator('[data-active-agent-phase="searching"]'))
    .toBeVisible();
  await expect(input.activeTurn.locator('[data-activity-category="searching"]'))
    .toContainText("Search release documentation");
  await input.capture("active-search-dark", input.activeTurn);

  await input.publish({
    type: "agent.activity",
    activity: { ...searchActivity, status: "completed" },
  });
  const codingActivity = {
    ...searchActivity,
    id: "activity-live-coding",
    kind: "file",
    title: "Edit response timeline",
    createdAt: input.activeAt(20),
  } as const;
  await input.publish({ type: "agent.activity", activity: codingActivity });
  await expect(input.activeTurn.locator('[data-active-agent-phase="coding"]'))
    .toBeVisible();
  await expect(input.activeTurn.locator('[data-activity-category="coding"]'))
    .toContainText("Edit response timeline");
  await input.capture("active-coding-dark", input.activeTurn);

  await input.publish({
    type: "agent.activity",
    activity: { ...codingActivity, status: "completed" },
  });
  await input.publish({
    type: "agent.reasoning",
    conversationId: input.conversationId,
    runId: input.runId,
    turnId: input.turnId,
    text: "Comparing the provider events with the current transcript projection.",
  });
  await expect(input.activeTurn.locator('[data-active-agent-phase="thinking"]'))
    .toBeVisible();
  await expect(input.activeTurn.locator('[data-agent-trace="thinking"]'))
    .toBeVisible();
  await input.capture("active-thinking-dark", input.activeTurn);
}
