import { describe, expect, it } from "vitest";

import { buildTurnExecutionStream } from "../../src/renderer/src/utils/responseTimeline";
import type {
  AgentActivity,
  AgentTurn,
  ChatMessage,
} from "../../src/shared/contracts";

const conversationId = "conversation-1";
const turnId = "turn-1";
const at = (second: number) =>
  `2026-07-27T08:00:${String(second).padStart(2, "0")}.000Z`;

function activity(
  id: string,
  second: number,
  overrides: Partial<AgentActivity> = {},
): AgentActivity {
  return {
    id,
    conversationId,
    runId: "run-1",
    turnId,
    kind: "tool",
    title: id,
    detail: null,
    status: "completed",
    createdAt: at(second),
    ...overrides,
  };
}

function commentary(
  id: string,
  second: number,
): ChatMessage {
  return {
    id,
    conversationId,
    turnId,
    role: "assistant",
    content: id,
    attachments: [],
    createdAt: at(second),
  };
}

describe("Minimal Workstream adjacent call grouping", () => {
  it("preserves created-time order and breaks only on commentary so attention stays in its group", () => {
    const activities = [
      activity("after-failure", 9),
      activity("old-success", 1),
      activity("warning", 5, {
        kind: "status",
        title: "Unsupported option skipped",
      }),
      activity("new-success", 2),
      activity("after-commentary", 4),
      activity("after-boundary-old", 6),
      activity("after-boundary-new", 7),
      activity("failure", 8, {
        kind: "command",
        title: "Verification failed",
        status: "failed",
      }),
    ];
    const stream = buildTurnExecutionStream({
      id: turnId,
      agentTurn: { updatedAt: at(10) } as AgentTurn,
      followUpMessages: [],
      commentaryMessages: [commentary("commentary", 3)],
      activities,
    });

    expect(stream.map((entry) =>
      entry.kind === "commentary"
        ? `commentary:${entry.id}`
        : entry.kind === "follow-up"
          ? `follow-up:${entry.id}`
          : entry.activities.map(({ id }) => id).join(","))).toEqual([
      "old-success,new-success",
      "commentary:commentary",
      "after-commentary,warning,after-boundary-old,after-boundary-new,failure,after-failure",
    ]);
  });
});
