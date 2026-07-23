import { describe, expect, it } from "vitest";

import type { AgentActivity, AgentReasoning, ChatMessage, CheckpointSummary } from "../../src/shared/contracts";
import {
  activityNeedsAttention,
  buildResponseTimeline,
  formatElapsed,
  shouldFollowTimeline,
  workSummaryLabel,
} from "../../src/renderer/src/utils/responseTimeline";

const conversationId = "11111111-1111-4111-8111-111111111111";

function message(id: string, role: ChatMessage["role"], content: string, createdAt: string): ChatMessage {
  return { id, conversationId, role, content, attachments: [], createdAt };
}

function activity(id: string, update: Partial<AgentActivity> = {}): AgentActivity {
  return {
    id,
    conversationId,
    runId: "run-1",
    kind: "tool",
    title: "Read files",
    detail: null,
    status: "completed",
    createdAt: "2026-07-23T10:00:02.000Z",
    ...update,
  };
}

describe("response timeline", () => {
  it("groups run output with its user turn and leaves the final answer visible", () => {
    const messages = [
      message("user-1", "user", "Inspect this", "2026-07-23T10:00:00.000Z"),
      message("assistant-1", "assistant", "Done.", "2026-07-23T10:00:08.000Z"),
      message("user-2", "user", "Now test it", "2026-07-23T10:01:00.000Z"),
      message("assistant-2", "assistant", "Tests pass.", "2026-07-23T10:01:09.000Z"),
    ];
    const activities = [
      activity("tool-1"),
      activity("tool-2", { title: "Run tests", kind: "command", createdAt: "2026-07-23T10:01:03.000Z" }),
    ];
    const reasonings: AgentReasoning[] = [{
      id: "reason-1",
      conversationId,
      runId: "run-1",
      content: "Check the focused suite.",
      status: "completed",
      createdAt: "2026-07-23T10:01:02.000Z",
    }];
    const checkpoints: CheckpointSummary[] = [{
      id: "checkpoint-1",
      conversationId,
      ref: "refs/inertia/checkpoints/test",
      label: "Before turn 1",
      turnIndex: 1,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      createdAt: "2026-07-23T09:59:59.000Z",
    }];

    const timeline = buildResponseTimeline({ messages, activities, reasonings, checkpoints, status: "completed" });
    const turns = timeline.flatMap((item) => item.kind === "turn" ? [item.turn] : []);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ assistantMessages: [{ content: "Done." }], toolCallCount: 1, checkpoint: { id: "checkpoint-1" } });
    expect(turns[1]).toMatchObject({ assistantMessages: [{ content: "Tests pass." }], toolCallCount: 1, reasoning: { content: "Check the focused suite." } });
    expect(workSummaryLabel(turns[1]!, Date.parse("2026-07-23T10:01:09.000Z"))).toBe("Worked for 9s · 1 action");
  });

  it("never folds failures or important warnings into the successful work row", () => {
    const warning = activity("warning", { kind: "status", title: "Unsupported interaction was skipped" });
    const failure = activity("failure", { kind: "error", title: "Command failed", status: "failed" });
    const success = activity("success");
    const timeline = buildResponseTimeline({
      messages: [
        message("user", "user", "Try it", "2026-07-23T10:00:00.000Z"),
        message("assistant", "assistant", "I could not complete it.", "2026-07-23T10:00:08.000Z"),
      ],
      activities: [success, warning, failure],
      reasonings: [],
      checkpoints: [],
      status: "failed",
    });
    const turn = timeline.find((item) => item.kind === "turn");
    expect(turn?.kind).toBe("turn");
    if (turn?.kind !== "turn") return;
    expect(turn.turn.foldableActivities.map(({ id }) => id)).toEqual(["success"]);
    expect(turn.turn.importantActivities.map(({ id }) => id)).toEqual(["warning", "failure"]);
    expect(activityNeedsAttention(warning)).toBe(true);
  });

  it("follows only near the bottom and formats bounded elapsed labels", () => {
    expect(shouldFollowTimeline(1_380, 500, 2_000)).toBe(true);
    expect(shouldFollowTimeline(900, 500, 2_000)).toBe(false);
    expect(shouldFollowTimeline(Number.NaN, 500, 2_000)).toBe(true);
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(125_000)).toBe("2m 5s");
    expect(formatElapsed(3_720_000)).toBe("1h 2m");
  });

  it("marks only the latest unsettled turn active", () => {
    const timeline = buildResponseTimeline({
      messages: [
        message("user-1", "user", "First", "2026-07-23T10:00:00.000Z"),
        message("assistant-1", "assistant", "First done", "2026-07-23T10:00:03.000Z"),
        message("user-2", "user", "Second", "2026-07-23T10:01:00.000Z"),
      ],
      activities: [],
      reasonings: [],
      checkpoints: [],
      status: "running",
    });
    const turns = timeline.flatMap((item) => item.kind === "turn" ? [item.turn] : []);
    expect(turns.map(({ isActive }) => isActive)).toEqual([false, true]);
    expect(turns[1]?.finishedAt).toBeNull();
  });

  it("keeps restart and other orphaned failures visible without a user turn", () => {
    const timeline = buildResponseTimeline({
      messages: [message("welcome", "system", "Welcome", "2026-07-23T10:00:00.000Z")],
      activities: [activity("recovery", {
        runId: "recovery-run",
        kind: "error",
        title: "The previous run ended when Inertia closed.",
        status: "failed",
        createdAt: "2026-07-23T10:00:01.000Z",
      })],
      reasonings: [],
      checkpoints: [],
      status: "failed",
    });
    expect(timeline).toContainEqual(expect.objectContaining({
      kind: "activity",
      activities: [expect.objectContaining({ id: "recovery", status: "failed" })],
    }));
  });
});
