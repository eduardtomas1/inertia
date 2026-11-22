import { describe, expect, it } from "vitest";

import type { AgentActivity, SubagentTrace } from "../../src/shared/contracts";
import {
  withDelegatedWork,
  withSubagentGroups,
} from "../../src/renderer/src/utils/response-timeline/subagentGroups";
import type { SubagentCallEntry } from "../../src/renderer/src/utils/response-timeline/subagentCalls";
import { taskTrace } from "./background-task-fixtures";

const at = (seconds: number): string => `2030-01-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;

type Entry =
  | { kind: "commentary"; id: string; createdAt: string }
  | { kind: "activity-group"; id: string; createdAt: string; activities: AgentActivity[] };

function prose(id: string, seconds: number): Entry {
  return { kind: "commentary", id, createdAt: at(seconds) };
}

function tools(id: string, seconds: number, activityIds: string[]): Entry {
  return {
    kind: "activity-group",
    id,
    createdAt: at(seconds),
    activities: activityIds.map((activityId, index) => ({
      id: activityId,
      conversationId: "conversation-1",
      runId: "run-1",
      turnId: "turn-1",
      kind: "tool",
      title: "Agent",
      detail: null,
      status: "completed",
      createdAt: at(seconds + index),
    })),
  };
}

function codexChild(id: string, seconds: number, update: Partial<SubagentTrace> = {}): SubagentTrace {
  return taskTrace({ id, providerId: "codex", activityId: null, createdAt: at(seconds), ...update });
}

function order(placed: ReadonlyArray<{ kind: string; id: string; traces?: SubagentTrace[] }>): string[] {
  return placed.map((entry) => entry.kind === "subagent-group"
    ? `group(${entry.traces!.map(({ id }) => id).join(",")})`
    : entry.id);
}

const stream: Entry[] = [prose("plan", 2), tools("reads", 4, ["read-a", "agent-call", "read-b"]), prose("wrap-up", 20)];

describe("delegated task placement in a turn's transcript", () => {
  it("leaves a turn without delegated tasks untouched", () => {
    expect(withSubagentGroups(stream, { traces: [], compact: [], foldable: true })).toBe(stream);
  });

  it("places a task with no tool row of its own where it started, not after later work", () => {
    const child = codexChild("child", 10);
    expect(order(withSubagentGroups(stream, { traces: [child], compact: [child], foldable: false })))
      .toEqual(["plan", "reads", "group(child)", "wrap-up"]);
    expect(order(withSubagentGroups(stream, { traces: [codexChild("early", 1)], compact: [], foldable: false })))
      .toEqual(["group(early)", "plan", "reads", "wrap-up"]);
  });

  it("places a task right after the work group holding the tool call that started it", () => {
    const linked = taskTrace({ id: "linked", activityId: "agent-call", createdAt: at(30) });
    expect(order(withSubagentGroups(stream, { traces: [linked], compact: [], foldable: false })))
      .toEqual(["plan", "reads", "group(linked)", "wrap-up"]);
  });

  it("falls back to the start time when the tool call is not in the transcript", () => {
    const hidden = taskTrace({ id: "hidden", activityId: "failed-agent-call", createdAt: at(3) });
    expect(order(withSubagentGroups(stream, { traces: [hidden], compact: [], foldable: false })))
      .toEqual(["plan", "group(hidden)", "reads", "wrap-up"]);
  });

  it("keeps a task where it started once it finishes, long after later work", () => {
    const running = codexChild("child", 10);
    const finished = { ...running, status: "completed" as const, isLive: false, sequence: 4, updatedAt: at(59) };
    const place = (trace: SubagentTrace): string[] =>
      order(withSubagentGroups(stream, { traces: [trace], compact: [trace], foldable: true }));
    expect(place(finished)).toEqual(place(running));
  });

  it("shares one group between tasks started together and splits tasks started apart", () => {
    const traces = [codexChild("first", 10), codexChild("second", 11), codexChild("later", 25)];
    expect(order(withSubagentGroups(stream, { traces, compact: traces, foldable: false })))
      .toEqual(["plan", "reads", "group(first,second)", "wrap-up", "group(later)"]);
  });

  it("keeps a task started by another task in its parent's group", () => {
    const parent = codexChild("parent", 10);
    const nested = codexChild("nested", 30, { parentTraceId: "parent" });
    expect(order(withSubagentGroups(stream, { traces: [parent, nested], compact: [parent, nested], foldable: false })))
      .toEqual(["plan", "reads", "group(parent,nested)", "wrap-up"]);
  });

  it("names a group after its first task and carries only its own compact rows and fold rule", () => {
    const linked = taskTrace({ id: "linked", activityId: "agent-call", createdAt: at(5) });
    const child = codexChild("child", 6);
    const [group] = withSubagentGroups(stream, { traces: [linked, child], compact: [child], foldable: true })
      .filter((entry) => entry.kind === "subagent-group");
    expect(group).toMatchObject({
      id: "subagent-group:linked",
      turnId: "turn-1",
      createdAt: at(5),
      foldable: true,
    });
    expect(group!.kind === "subagent-group" && group.compact.map(({ id }) => id)).toEqual(["child"]);
  });

  it("places called agents and other tasks in one chronological pass", () => {
    const call = {
      kind: "subagent-call",
      id: "subagent-call:called",
      createdAt: at(3),
    } as SubagentCallEntry;
    const child = codexChild("child", 10);
    expect(order(withDelegatedWork(stream, { calls: [call], traces: [child], compact: [child], foldable: false })))
      .toEqual(["plan", "subagent-call:called", "reads", "group(child)", "wrap-up"]);
  });
});
