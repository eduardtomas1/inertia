import type {
  CompactionSummaryChunk,
  CompactionUpdate,
} from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import {
  AcpCompactionProjection,
} from "../../src/server/provider/acp-compaction-projection";
import { createAgentHarnessEmitter } from "../../src/server/provider/agent-harness";

function update(
  compactionId: string,
  status: string,
  error?: string | null,
): CompactionUpdate {
  return {
    compactionId,
    status,
    ...(error === undefined ? {} : { error }),
  };
}

function chunk(compactionId: string): CompactionSummaryChunk {
  return {
    compactionId,
    content: { type: "text", text: "Retained context, not assistant output" },
  };
}

function projection() {
  const activities: Array<{
    activityId?: string;
    phase: string;
    label: string;
    detail?: string;
  }> = [];
  const emitter = createAgentHarnessEmitter("cursor", "conversation", {
    onEvent: (event) => {
      if (event.type === "activity") activities.push(event);
    },
  });
  return {
    activities,
    value: new AcpCompactionProjection("Cursor", "cursor", emitter),
  };
}

describe("ACP compaction projection", () => {
  it("sequences active summary chunks and never projects summary text", () => {
    const { activities, value } = projection();

    expect(value.observeUpdate(update("compact-1", "in_progress")))
      .toBe("in_progress");
    expect(value.observeUpdate(update("compact-1", "in_progress")))
      .toBe("in_progress");
    expect(() => value.observeSummaryChunk(chunk("compact-1"))).not.toThrow();
    expect(value.observeUpdate(update("compact-1", "completed")))
      .toBe("completed");
    expect(activities).toEqual([
      expect.objectContaining({
        activityId: "cursor:compaction:compact-1",
        phase: "started",
        detail: "Status: in_progress",
      }),
      expect.objectContaining({
        activityId: "cursor:compaction:compact-1",
        phase: "completed",
        detail: "Status: completed",
      }),
    ]);
    expect(JSON.stringify(activities)).not.toContain("Retained context");
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "accepts terminal-first %s upserts and deduplicates same-status patches",
    (status) => {
      const { activities, value } = projection();
      expect(value.observeUpdate(update("compact-1", status))).toBe(status);
      expect(value.observeUpdate(update("compact-1", status))).toBe(status);
      expect(activities).toHaveLength(1);
    },
  );

  it("rejects summary chunks outside the matching active lifecycle", () => {
    const { value } = projection();
    expect(() => value.observeSummaryChunk(chunk("compact-1")))
      .toThrow("outside a matching in-progress lifecycle");
    value.observeUpdate(update("compact-1", "in_progress"));
    expect(() => value.observeSummaryChunk(chunk("compact-2")))
      .toThrow("outside a matching in-progress lifecycle");
    value.observeUpdate(update("compact-1", "cancelled"));
    expect(() => value.observeSummaryChunk(chunk("compact-1")))
      .toThrow("outside a matching in-progress lifecycle");
    expect(() => value.observeUpdate(update("compact-1", "in_progress")))
      .toThrow("restarted a terminal context compaction");
  });

  it("rejects contradictory terminal patches", () => {
    const { value } = projection();
    value.observeUpdate(update("compact-1", "completed"));
    expect(() => value.observeUpdate(update("compact-1", "failed", "late failure")))
      .toThrow("changed a terminal context compaction status");
  });

  it("validates but does not project mutable terminal error patches", () => {
    const { activities, value } = projection();
    value.observeUpdate(update("compact-1", "failed", "first detail"));
    value.observeUpdate(update("compact-1", "failed"));
    value.observeUpdate(update("compact-1", "failed", "replacement detail"));
    value.observeUpdate(update("compact-1", "failed", "replacement detail"));
    value.observeUpdate(update("compact-1", "failed", null));
    value.observeUpdate(update("compact-1", "failed", null));

    expect(activities).toEqual([expect.objectContaining({
      activityId: "cursor:compaction:compact-1",
      phase: "failed",
      detail: "Status: failed",
    })]);
  });

  it("keeps future statuses uncorrelated and preserves active lifecycle state", () => {
    const { activities, value } = projection();
    value.observeUpdate(update("compact-1", "in_progress"));
    expect(value.observeUpdate(update("compact-1", "future_paused")))
      .toBe("unknown");
    expect(value.observeUpdate(update("compact-1", "failed", "limit changed")))
      .toBe("failed");
    expect(activities.at(1)).toMatchObject({
      phase: "info",
      detail: "Status: future_paused",
    });
    expect(activities.at(1)?.activityId).toBeUndefined();
    expect(activities.at(2)).toMatchObject({
      activityId: "cursor:compaction:compact-1",
      phase: "failed",
      detail: "Status: failed",
    });
  });

  it("summarizes explicit-compaction completion authority across all lifecycles", () => {
    expect(projection().value.completionEvidence()).toBe("unobserved");

    const completed = projection().value;
    completed.observeUpdate(update("compact-1", "in_progress"));
    completed.observeUpdate(update("compact-1", "completed"));
    expect(completed.completionEvidence()).toBe("completed");

    for (const status of ["in_progress", "failed", "cancelled"] as const) {
      const value = projection().value;
      value.observeUpdate(update("compact-1", status));
      expect(value.completionEvidence()).toBe("unconfirmed");
    }

    const mixed = projection().value;
    mixed.observeUpdate(update("compact-1", "completed"));
    mixed.observeUpdate(update("compact-2", "failed"));
    expect(mixed.completionEvidence()).toBe("unconfirmed");

    const future = projection().value;
    future.observeUpdate(update("compact-1", "future_paused"));
    expect(future.completionEvidence()).toBe("unconfirmed");

    const futureThenCompleted = projection().value;
    futureThenCompleted.observeUpdate(update("compact-1", "in_progress"));
    futureThenCompleted.observeUpdate(update("compact-1", "future_paused"));
    futureThenCompleted.observeUpdate(update("compact-1", "completed"));
    expect(futureThenCompleted.completionEvidence()).toBe("completed");
  });

  it("bounds lifecycle state and preserves distinct safe IDs after truncation", () => {
    const { activities, value } = projection();
    const commonPrefix = "x".repeat(999);
    value.observeUpdate(update(`${commonPrefix}a`, "in_progress"));
    value.observeUpdate(update(`${commonPrefix}b`, "in_progress"));
    const [first, second] = activities.map(({ activityId }) => activityId);
    expect(first).toHaveLength(1_000);
    expect(second).toHaveLength(1_000);
    expect(first).not.toBe(second);

    for (let index = 2; index < 256; index += 1) {
      value.observeUpdate(update(`compact-${index}`, "in_progress"));
    }
    expect(() => value.observeUpdate(update("compact-future-overflow", "future_paused")))
      .toThrow("bounded context compaction budget");
    expect(() => value.observeUpdate(update("compact-overflow", "in_progress")))
      .toThrow("bounded context compaction budget");
  });
});
