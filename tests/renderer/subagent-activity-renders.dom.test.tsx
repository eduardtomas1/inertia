import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentActivity, SubagentTrace } from "../../src/shared/contracts";
import { ActivityGroup } from "../../src/renderer/src/components/response-timeline/activity";
import { TurnSubagentActivities } from "../../src/renderer/src/components/response-timeline/layers";
import { taskTrace } from "./background-task-fixtures";

const counts = vi.hoisted(() => ({ groupRenders: 0, rowRenders: {} as Record<string, number> }));

vi.mock("../../src/renderer/src/components/response-timeline/subagentActivityContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/src/components/response-timeline/subagentActivityContext")>();
  return {
    ...actual,
    useLinkedSubagent: (activityId: string) => {
      counts.rowRenders[activityId] = (counts.rowRenders[activityId] ?? 0) + 1;
      return actual.useLinkedSubagent(activityId);
    },
  };
});

vi.mock("../../src/renderer/src/utils/responseTimeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/src/utils/responseTimeline")>();
  return {
    ...actual,
    activitySummarySentence: (...args: Parameters<typeof actual.activitySummarySentence>) => {
      counts.groupRenders += 1;
      return actual.activitySummarySentence(...args);
    },
  };
});

function activity(id: string, title: string): AgentActivity {
  return {
    id,
    conversationId: "conversation-1",
    runId: "run-1",
    turnId: "turn-1",
    kind: "tool",
    title,
    detail: null,
    status: "completed",
    createdAt: "2030-01-01T00:00:00.000Z",
  };
}

const linkedEntry = {
  kind: "activity-group" as const,
  id: "group-linked",
  createdAt: "2030-01-01T00:00:00.000Z",
  activities: [activity("activity-agent", "Agent"), activity("activity-read", "Read src/a.ts")],
};
const plainEntry = {
  kind: "activity-group" as const,
  id: "group-plain",
  createdAt: "2030-01-01T00:00:01.000Z",
  activities: [activity("activity-grep", "Grep TODO"), activity("activity-edit", "Edit src/b.ts")],
};

function flush(sequence: number, update: Partial<SubagentTrace> = {}): SubagentTrace[] {
  return [
    taskTrace({
      id: "trace-agent",
      activityId: "activity-agent",
      description: "Survey the repository",
      steps: Array.from({ length: Math.min(sequence, 8) }, (_, index) => ({ label: `Read · file-${index}.ts`, status: "running" as const })),
      sequence,
      ...update,
    }),
    taskTrace({ id: "trace-other-turn-row", activityId: "activity-elsewhere", sequence: 1 }),
  ];
}

afterEach(() => cleanup());

describe("delegated task telemetry flushes", () => {
  it("re-render only the row whose own task changed, not its group or other groups", () => {
    const view = (traces: SubagentTrace[]) => (
      <TurnSubagentActivities subagents={traces}>
        <ActivityGroup entry={linkedEntry} />
        <ActivityGroup entry={plainEntry} />
      </TurnSubagentActivities>
    );
    const { rerender } = render(view(flush(1)));
    expect(document.querySelector('[data-subagent-trace="trace-agent"]')?.textContent).toContain("Read · file-0.ts");
    expect(counts.rowRenders).toEqual({ "activity-agent": 1, "activity-read": 1, "activity-grep": 1, "activity-edit": 1 });
    counts.groupRenders = 0;
    counts.rowRenders = {};

    for (let sequence = 2; sequence <= 6; sequence += 1) rerender(view(flush(sequence)));

    expect(document.querySelector('[data-subagent-trace="trace-agent"]')?.textContent).toContain("Read · file-5.ts");
    expect(counts.groupRenders).toBe(0);
    expect(counts.rowRenders).toEqual({ "activity-agent": 5 });

    rerender(view(flush(6)));
    expect(counts.rowRenders).toEqual({ "activity-agent": 5 });

    rerender(view(flush(7, { status: "completed", isLive: false })));
    expect(counts.groupRenders).toBe(1);
    expect(counts.rowRenders["activity-grep"]).toBeUndefined();
    expect(counts.rowRenders["activity-edit"]).toBeUndefined();
  });
});
