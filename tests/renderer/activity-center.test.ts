import { describe, expect, it } from "vitest";

import {
  activityRunActions,
  activityRunSections,
  activityRunSummary,
  activityStatusLabel,
  activityWaitingKind,
} from "../../src/renderer/src/utils/activityCenter";
import type { Conversation, WorkspaceRun } from "../../src/shared/contracts";

function run(overrides: Partial<WorkspaceRun> = {}): WorkspaceRun {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "check",
    projectId: "22222222-2222-4222-8222-222222222222",
    conversationId: "33333333-3333-4333-8333-333333333333",
    actionId: "typecheck",
    label: "typecheck",
    detail: "npm run typecheck",
    status: "running",
    canStop: true,
    port: null,
    startedAt: "2026-07-23T10:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

function conversation(attentionKind: Conversation["attentionKind"]): Conversation {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    projectId: "22222222-2222-4222-8222-222222222222",
    title: "Review",
    providerId: "claude",
    model: "",
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    status: "needs-input",
    attentionKind,
    branch: null,
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: null,
    createdAt: "2026-07-23T10:00:00.000Z",
    updatedAt: "2026-07-23T10:00:00.000Z",
  };
}

describe("Runs control model", () => {
  it("prioritizes attention, then active work, then bounded recent history", () => {
    const sections = activityRunSections([
      run({
        id: "11111111-1111-4111-8111-111111111101",
        status: "succeeded",
        finishedAt: "2026-07-23T10:00:05.000Z",
        startedAt: "2026-07-23T10:00:00.000Z",
      }),
      run({
        id: "11111111-1111-4111-8111-111111111102",
        status: "running",
        startedAt: "2026-07-23T10:01:00.000Z",
      }),
      run({
        id: "11111111-1111-4111-8111-111111111103",
        status: "failed",
        finishedAt: "2026-07-23T10:02:05.000Z",
        startedAt: "2026-07-23T10:02:00.000Z",
      }),
      run({
        id: "11111111-1111-4111-8111-111111111104",
        kind: "agent",
        status: "waiting",
        startedAt: "2026-07-23T10:03:00.000Z",
      }),
    ], Date.parse("2026-07-23T10:04:00.000Z"));

    expect(sections.map(({ id }) => id)).toEqual(["attention", "active", "recent"]);
    expect(sections[0]?.runs.map(({ status }) => status)).toEqual(["waiting", "failed"]);
    expect(sections[1]?.runs.map(({ status }) => status)).toEqual(["running"]);
    expect(sections[2]?.runs.map(({ status }) => status)).toEqual(["succeeded"]);
  });

  it("omits empty sections and summarizes attention separately from active work", () => {
    const completed = run({
      status: "succeeded",
      finishedAt: "2026-07-23T10:00:05.000Z",
    });
    expect(activityRunSections([completed]).map(({ id }) => id)).toEqual(["recent"]);
    const history = Array.from({ length: 14 }, (_, index) => run({
      id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      status: "succeeded",
      startedAt: `2026-07-23T10:${String(index).padStart(2, "0")}:00.000Z`,
      finishedAt: `2026-07-23T10:${String(index).padStart(2, "0")}:05.000Z`,
    }));
    expect(activityRunSections(history)[0]?.runs).toHaveLength(12);
    expect(activityRunSections([])).toEqual([]);
    expect(activityRunSummary([
      completed,
      run({ id: "11111111-1111-4111-8111-111111111102", status: "waiting" }),
      run({
        id: "11111111-1111-4111-8111-111111111103",
        status: "failed",
        canStop: false,
        finishedAt: "2026-07-23T10:00:05.000Z",
      }),
    ], Date.parse("2026-07-23T10:01:00.000Z"))).toEqual({ attentionCount: 2, activeCount: 1 });
  });

  it("moves historical failures into recent history instead of leaving a permanent badge", () => {
    const staleFailure = run({
      status: "failed",
      canStop: false,
      startedAt: "2026-07-20T10:00:00.000Z",
      finishedAt: "2026-07-20T10:00:05.000Z",
    });
    const now = Date.parse("2026-07-23T10:00:00.000Z");
    expect(activityRunSections([staleFailure], now).map(({ id }) => id)).toEqual(["recent"]);
    expect(activityRunSummary([staleFailure], now)).toEqual({ attentionCount: 0, activeCount: 0 });
  });

  it("shows only controls backed by the run's real capabilities", () => {
    expect(activityRunActions(run())).toMatchObject({
      openThread: true,
      openLocation: true,
      openTerminal: true,
      openPreview: false,
      stop: true,
      rerun: false,
      dismiss: false,
    });
    expect(activityRunActions(run({
      status: "failed",
      canStop: false,
      finishedAt: "2026-07-23T10:00:05.000Z",
    }))).toMatchObject({
      stop: false,
      rerun: true,
      dismiss: true,
      failureDetails: true,
    });
    expect(activityRunActions(run({
      kind: "source-control",
      actionId: null,
      status: "failed",
      canStop: false,
      finishedAt: "2026-07-23T10:00:05.000Z",
    }))).toMatchObject({
      stop: false,
      rerun: false,
      dismiss: true,
    });
  });

  it("exposes detected service ports without claiming unavailable previews", () => {
    expect(activityRunActions(run({ kind: "service", port: 4173 })).openPreview).toBe(true);
    expect(activityRunActions(run({ kind: "service", port: null })).openPreview).toBe(false);
    expect(activityRunActions(run({
      kind: "service",
      port: 4173,
      status: "succeeded",
      canStop: false,
      finishedAt: "2026-07-23T10:00:05.000Z",
    })).openPreview).toBe(false);
  });

  it("distinguishes approval and input waits using the emitting conversation state", () => {
    const waiting = run({ kind: "agent", status: "waiting" });
    expect(activityWaitingKind(waiting, [conversation("approval")])).toBe("approval");
    expect(activityStatusLabel(waiting, Date.parse("2026-07-23T10:00:08.000Z"), "approval"))
      .toBe("Waiting for approval · 8s");
    expect(activityWaitingKind(waiting, [conversation("input")])).toBe("input");
    expect(activityStatusLabel(waiting, Date.parse("2026-07-23T10:00:08.000Z"), "input"))
      .toBe("Waiting for input · 8s");
  });
});
