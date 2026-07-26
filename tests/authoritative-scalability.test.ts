import { describe, expect, it } from "vitest";

import type {
  AgentActivity,
  AgentTurn,
  ChatMessage,
} from "../src/shared/contracts";
import {
  continuationIdentityForSelection,
  nativeModelSelection,
} from "../src/shared/model-routing";
import {
  buildResponseTimeline,
  type ResponseTimelineItem,
} from "../src/renderer/src/utils/responseTimeline";

const TURN_COUNT = 500;
const MESSAGES_PER_TURN = 20;
const ACTIVITIES_PER_TURN = 10;

const selection = nativeModelSelection({
  providerId: "codex",
  modelId: "gpt-scalability",
  reasoningEffort: "high",
});
const continuationIdentity = continuationIdentityForSelection(
  selection,
  null,
  true,
);

function turn(index: number, requestedAt: string): AgentTurn {
  const id = `turn-${index}`;
  return {
    id,
    conversationId: "conversation-scalability",
    runId: `run-${index}`,
    userMessageId: `message-${index}-0`,
    terminalAssistantMessageId: `message-${index}-${MESSAGES_PER_TURN - 1}`,
    providerId: "codex",
    modelSelection: selection,
    continuationIdentity,
    harnessId: selection.harnessId,
    backendProfileId: selection.backendProfileId,
    model: selection.modelId,
    modelAlias: selection.alias,
    reasoningEffort: selection.reasoningEffort ?? "",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    providerSessionAfter: `session-${index}`,
    requestedAt,
    startedAt: requestedAt,
    completedAt: requestedAt,
    status: "completed",
    terminalReason: null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: selection.backendConfigurationRevision,
    association: "authoritative",
    createdAt: requestedAt,
    updatedAt: requestedAt,
  };
}

function messagesFor(owner: AgentTurn, turnIndex: number): ChatMessage[] {
  return Array.from({ length: MESSAGES_PER_TURN }, (_, messageIndex) => ({
    id: `message-${turnIndex}-${messageIndex}`,
    conversationId: owner.conversationId,
    turnId: owner.id,
    role: messageIndex === 0 ? "user" : "assistant",
    content: `Turn ${turnIndex} message ${messageIndex}`,
    attachments: [],
    createdAt: owner.requestedAt,
  }));
}

function activitiesFor(owner: AgentTurn, turnIndex: number): AgentActivity[] {
  return Array.from({ length: ACTIVITIES_PER_TURN }, (_, activityIndex) => ({
    id: `activity-${turnIndex}-${activityIndex}`,
    conversationId: owner.conversationId,
    runId: owner.runId,
    turnId: owner.id,
    kind: "tool",
    title: `Activity ${activityIndex}`,
    detail: null,
    status: "completed",
    createdAt: owner.requestedAt,
  }));
}

describe("authoritative transcript scalability", () => {
  it("projects 10,000 messages and thousands of activities across hundreds of turns linearly", () => {
    const baseTime = Date.parse("2030-01-01T00:00:00.000Z");
    const turns = Array.from({ length: TURN_COUNT }, (_, index) =>
      turn(index, new Date(baseTime + index).toISOString()));
    const messages = turns.flatMap(messagesFor);
    const activities = turns.flatMap(activitiesFor);
    expect(messages).toHaveLength(10_000);
    expect(activities).toHaveLength(5_000);

    const startedAt = performance.now();
    const timeline = buildResponseTimeline({
      turns,
      messages,
      activities,
      reasonings: [],
      checkpoints: [],
    });
    const elapsed = performance.now() - startedAt;
    const turnRows = timeline.filter(
      (item): item is Extract<ResponseTimelineItem, { kind: "turn" }> =>
        item.kind === "turn",
    );

    expect(turnRows).toHaveLength(TURN_COUNT);
    expect(turnRows.reduce((total, row) =>
      total + 1 + row.turn.assistantMessages.length, 0)).toBe(10_000);
    expect(turnRows.reduce((total, row) =>
      total + row.turn.activities.length, 0)).toBe(5_000);
    expect(turnRows[0]?.turn).toMatchObject({
      id: "turn-0",
      userMessage: { id: "message-0-0" },
      terminalAssistantMessage: {
        id: `message-0-${MESSAGES_PER_TURN - 1}`,
      },
    });
    expect(turnRows.at(-1)?.turn.id).toBe(`turn-${TURN_COUNT - 1}`);
    expect(elapsed).toBeLessThan(5_000);
  });
});
