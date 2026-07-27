import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ActivityGroup } from "../../src/renderer/src/components/ResponseTimeline";
import {
  buildTurnExecutionStream,
  resolveActivityGroupPresentation,
  type TurnExecutionStreamEntry,
} from "../../src/renderer/src/utils/responseTimeline";
import type {
  AgentActivity,
  AgentTurn,
  ChatMessage,
} from "../../src/shared/contracts";

const timelineSource = readFileSync(
  new URL("../../src/renderer/src/components/ResponseTimeline.tsx", import.meta.url),
  "utf8",
);

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

function groupEntry(
  activities: AgentActivity[],
): Extract<TurnExecutionStreamEntry, { kind: "activity-group" }> {
  return {
    kind: "activity-group",
    id: `activity-group:${activities[0]!.id}`,
    createdAt: activities[0]!.createdAt,
    activities,
  };
}

describe("Minimal Workstream adjacent call grouping", () => {
  it("preserves created-time order and breaks on commentary, warnings, and failures", () => {
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
      commentaryMessages: [commentary("commentary", 3)],
      activities,
    });

    expect(stream.map((entry) =>
      entry.kind === "commentary"
        ? `commentary:${entry.id}`
        : entry.activities.map(({ id }) => id).join(","))).toEqual([
      "old-success,new-success",
      "commentary:commentary",
      "after-commentary",
      "warning",
      "after-boundary-old,after-boundary-new",
      "failure",
      "after-failure",
    ]);
  });

  it("keeps attention and the newest meaningful call visible, then expands in original order", () => {
    const activities = [
      activity("old-success", 1),
      activity("warning", 2, {
        kind: "status",
        title: "Unsupported option skipped",
      }),
      activity("new-success", 3),
      activity("failure", 4, {
        title: "Verification failed",
        status: "failed",
      }),
    ];

    expect(resolveActivityGroupPresentation(activities, false)).toMatchObject({
      visibleActivities: [
        { id: "warning" },
        { id: "new-success" },
        { id: "failure" },
      ],
      hiddenCount: 1,
    });
    expect(resolveActivityGroupPresentation(activities, true)).toEqual({
      visibleActivities: activities,
      hiddenCount: 1,
    });
  });

  it("renders keyboard-native singular/plural collapsed controls and attention outside collapse", () => {
    const singular = renderToStaticMarkup(createElement(ActivityGroup, {
      entry: groupEntry([
        activity("old", 1),
        activity("new", 2),
      ]),
    }));
    const plural = renderToStaticMarkup(createElement(ActivityGroup, {
      entry: groupEntry([
        activity("old-one", 1),
        activity("old-two", 2),
        activity("newest", 3),
      ]),
      onBeforeToggle: vi.fn(),
      onAfterToggle: vi.fn(),
    }));
    const attention = renderToStaticMarkup(createElement(ActivityGroup, {
      entry: groupEntry([
        activity("failure", 4, {
          title: "Verification failed",
          status: "failed",
        }),
      ]),
    }));

    expect(singular).toContain('data-activity-group-mode="calls"');
    expect(singular).toContain('aria-expanded="false"');
    expect(singular).toContain("+1 previous tool call");
    expect(singular).not.toContain(">old<");
    expect(singular).toContain(">new<");
    expect(plural).toContain("+2 previous tool calls");
    expect(plural).not.toContain(">old-one<");
    expect(plural).not.toContain(">old-two<");
    expect(plural).toContain(">newest<");
    expect(attention).toContain('data-activity-group-mode="attention"');
    expect(attention).toContain("Verification");
    expect(attention).not.toContain("previous tool");
  });

  it("keeps expansion wired through the shared scroll-anchor restoration path", () => {
    expect(timelineSource).toContain("onBeforeToggle?.();");
    expect(timelineSource).toContain("setExpanded((current) => !current)");
    expect(timelineSource).toContain(
      "window.requestAnimationFrame(() => onAfterToggle?.())",
    );
    expect(timelineSource).toContain(
      "onBeforeToggle={captureExpansionAnchor}",
    );
    expect(timelineSource).toContain(
      "onAfterToggle={restoreExpansionAnchor}",
    );
    expect(timelineSource).toContain(
      "virtualizer.shouldAdjustScrollPositionOnItemSizeChange",
    );
  });
});
