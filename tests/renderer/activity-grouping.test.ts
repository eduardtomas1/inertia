import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ActivityGroup } from "../../src/renderer/src/components/ResponseTimeline";
import {
  buildTurnExecutionStream,
  type TurnExecutionStreamEntry,
} from "../../src/renderer/src/utils/responseTimeline";
import type {
  AgentActivity,
  AgentTurn,
  ChatMessage,
} from "../../src/shared/contracts";

const activitySource = readFileSync(
  new URL("../../src/renderer/src/components/response-timeline/activity.tsx", import.meta.url),
  "utf8",
);
const viewportSource = readFileSync(
  new URL("../../src/renderer/src/components/response-timeline/viewport.tsx", import.meta.url),
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

  it("renders multi-call groups as one summary control over a live window and single calls as plain rows", () => {
    const live = renderToStaticMarkup(createElement(ActivityGroup, {
      entry: groupEntry([
        activity("read-one", 1, { kind: "tool", title: "Read" }),
        activity("read-two", 2, { kind: "tool", title: "Read" }),
        activity("search", 3, { kind: "tool", title: "Grep" }),
        activity("verify", 4, {
          kind: "command",
          title: "Command",
          detail: "Command:\n/bin/bash -lc 'npm test'",
          status: "failed",
        }),
        activity("current", 5, {
          kind: "command",
          title: "Command",
          detail: "Command:\n/bin/bash -lc 'ant compile'",
          status: "running",
        }),
      ]),
      onBeforeToggle: vi.fn(),
      onAfterToggle: vi.fn(),
    }));
    const settled = renderToStaticMarkup(createElement(ActivityGroup, {
      entry: groupEntry([
        activity("old", 1),
        activity("new", 2),
      ]),
      settled: true,
    }));
    const single = renderToStaticMarkup(createElement(ActivityGroup, {
      entry: groupEntry([
        activity("failure", 4, {
          title: "Verification failed",
          status: "failed",
        }),
      ]),
      settled: true,
    }));

    expect(live).toContain('data-activity-group-mode="attention"');
    expect(live).toContain('data-activity-group-state="live"');
    expect(live).toContain('aria-expanded="false"');
    expect(live).toContain('aria-label="2 commands, 2 files read, 1 search, 1 failed"');
    expect(live).toContain('class="turn-activity-group-summary"');
    expect(live).toContain('data-running="true"');
    expect(live.match(/data-folded="false"/g)).toHaveLength(4);
    expect(live.match(/data-folded="true"/g)).toHaveLength(1);
    expect(live).toContain(">Running</span>");
    expect(live).toContain(" ant compile</span>");
    expect(settled).toContain('data-activity-group-state="folded"');
    expect(settled).toContain('aria-label="2 tool calls"');
    expect(settled.match(/data-folded="true"/g)).toHaveLength(2);
    expect(settled).toContain('aria-hidden="true"');
    expect(single).toContain('data-activity-group-state="single"');
    expect(single).toContain('data-activity-group-mode="attention"');
    expect(single).toContain("Verification");
    expect(single).not.toContain("turn-activity-group-summary");
  });

  it("keeps expansion wired through the shared scroll-anchor restoration path", () => {
    expect(activitySource).toContain("onBeforeToggle?.();");
    expect(activitySource).toContain("setExpanded((current) => !current)");
    expect(activitySource).toContain(
      "window.requestAnimationFrame(() => onAfterToggle?.())",
    );
    expect(viewportSource).toContain(
      "onBeforeToggle={captureExpansionAnchor}",
    );
    expect(viewportSource).toContain(
      "onAfterToggle={restoreExpansionAnchor}",
    );
    expect(viewportSource).toContain(
      "virtualizer.shouldAdjustScrollPositionOnItemSizeChange",
    );
  });
});
