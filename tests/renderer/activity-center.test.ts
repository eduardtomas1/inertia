import { describe, expect, it } from "vitest";

import {
  activityRunActions,
  activityRunProviderId,
  activityRunPresentation,
  activityRunSections,
  activityRunSummary,
  activityStatusLabel,
  activityWaitingKind,
} from "../../src/renderer/src/utils/activityCenter";
import type { Conversation, WorkspaceRun } from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";

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
    attentionState: "acknowledged",
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
    modelSelection: nativeModelSelection({ providerId: "claude" }),
    continuationIdentity: null,
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
  it("groups visible work chronologically while preserving status priority signals", () => {
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
        attentionState: "unseen",
        finishedAt: "2026-07-23T10:02:05.000Z",
        startedAt: "2026-07-23T10:02:00.000Z",
      }),
      run({
        id: "11111111-1111-4111-8111-111111111104",
        kind: "agent",
        status: "waiting",
        attentionState: "unseen",
        startedAt: "2026-07-23T10:03:00.000Z",
      }),
      run({
        id: "11111111-1111-4111-8111-111111111105",
        status: "succeeded",
        startedAt: "2026-07-22T10:00:00.000Z",
        finishedAt: "2026-07-22T10:00:05.000Z",
      }),
      run({
        id: "11111111-1111-4111-8111-111111111106",
        status: "succeeded",
        startedAt: "2026-07-20T10:00:00.000Z",
        finishedAt: "2026-07-20T10:00:05.000Z",
      }),
    ], Date.parse("2026-07-23T10:04:00.000Z"));

    expect(sections.map(({ id }) => id)).toEqual(["recent", "yesterday", "earlier"]);
    expect(sections[0]?.runs.map(({ status }) => status))
      .toEqual(["waiting", "failed", "running", "succeeded"]);
    expect(sections[1]?.runs).toHaveLength(1);
    expect(sections[2]?.runs).toHaveLength(1);
  });

  it("omits empty sections and summarizes attention separately from active work", () => {
    const completed = run({
      status: "succeeded",
      finishedAt: "2026-07-23T10:00:05.000Z",
    });
    const now = Date.parse("2026-07-23T10:01:00.000Z");
    expect(activityRunSections([completed], now).map(({ id }) => id)).toEqual(["recent"]);
    const history = Array.from({ length: 14 }, (_, index) => run({
      id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      status: "succeeded",
      startedAt: `2026-07-23T10:${String(index).padStart(2, "0")}:00.000Z`,
      finishedAt: `2026-07-23T10:${String(index).padStart(2, "0")}:05.000Z`,
    }));
    expect(activityRunSections(history, now)[0]?.runs).toHaveLength(12);
    expect(activityRunSections([])).toEqual([]);
    expect(activityRunSummary([
      completed,
      run({ id: "11111111-1111-4111-8111-111111111102", status: "waiting" }),
      run({
        id: "11111111-1111-4111-8111-111111111103",
        status: "failed",
        attentionState: "seen",
        canStop: false,
        finishedAt: "2026-07-23T10:00:05.000Z",
      }),
    ], now)).toEqual({ attentionCount: 2, activeCount: 1 });
  });

  it("keeps historical failures visible until explicit acknowledgement", () => {
    const historicalFailure = run({
      status: "failed",
      attentionState: "seen",
      canStop: false,
      startedAt: "2026-07-20T10:00:00.000Z",
      finishedAt: "2026-07-20T10:00:05.000Z",
    });
    const now = Date.parse("2026-07-23T10:00:00.000Z");
    expect(activityRunSections([historicalFailure], now).map(({ id }) => id)).toEqual(["earlier"]);
    expect(activityRunSummary([historicalFailure], now)).toEqual({ attentionCount: 1, activeCount: 0 });

    const acknowledged = { ...historicalFailure, attentionState: "acknowledged" as const };
    expect(activityRunSections([acknowledged], now).map(({ id }) => id)).toEqual(["earlier"]);
    expect(activityRunSummary([acknowledged], now)).toEqual({ attentionCount: 0, activeCount: 0 });
    expect(activityRunSections([{ ...historicalFailure, attentionState: "dismissed" }], now)).toEqual([]);
  });

  it("keeps unseen successful agent work unread in recent without raising attention", () => {
    const completed = run({
      kind: "agent",
      status: "succeeded",
      attentionState: "unseen",
      canStop: false,
      finishedAt: "2026-07-23T10:00:05.000Z",
    });
    expect(activityRunSections(
      [completed],
      Date.parse("2026-07-23T10:01:00.000Z"),
    ).map(({ id }) => id)).toEqual(["recent"]);
    expect(activityRunSummary([completed])).toEqual({ attentionCount: 0, activeCount: 0 });
    expect(activityRunSummary([{ ...completed, finishedAt: null }])).toEqual({
      attentionCount: 0,
      activeCount: 0,
    });
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
      attentionState: "seen",
      canStop: false,
      finishedAt: "2026-07-23T10:00:05.000Z",
    }))).toMatchObject({
      stop: false,
      rerun: true,
      acknowledge: true,
      dismiss: true,
      failureDetails: true,
    });
    expect(activityRunActions(run({
      kind: "source-control",
      actionId: null,
      status: "failed",
      attentionState: "seen",
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
    const waiting = run({ kind: "agent", status: "waiting", attentionState: "seen" });
    expect(activityRunActions(waiting)).toMatchObject({ acknowledge: false, dismiss: false });
    expect(activityWaitingKind(waiting, [conversation("approval")])).toBe("approval");
    expect(activityStatusLabel(waiting, Date.parse("2026-07-23T10:00:08.000Z"), "approval"))
      .toBe("Waiting for approval · 8s");
    expect(activityWaitingKind(waiting, [conversation("input")])).toBe("input");
    expect(activityStatusLabel(waiting, Date.parse("2026-07-23T10:00:08.000Z"), "input"))
      .toBe("Waiting for input · 8s");
  });

  it("attributes only canonical provider-owned run projections", () => {
    expect(activityRunProviderId(run({
      kind: "agent",
      label: "Codex · GPT-5.6-Sol",
    }))).toBe("codex");
    expect(activityRunProviderId(run({
      kind: "check",
      actionId: null,
      detail: "Claude · Historical chat",
    }))).toBe("claude");
    expect(activityRunProviderId(run({
      kind: "check",
      actionId: "typecheck",
      detail: "Codex · user-authored command",
    }))).toBeNull();
    expect(activityRunProviderId(run({
      kind: "source-control",
      actionId: null,
      detail: "Codex · pushed branch",
    }))).toBeNull();
    expect(activityRunProviderId(run({
      kind: "agent",
      label: "Codexical review",
    }))).toBeNull();
  });

  it("uses occurrence age for settled work instead of execution duration", () => {
    const now = Date.parse("2026-07-23T10:10:00.000Z");
    const completed = run({
      status: "succeeded",
      canStop: false,
      startedAt: "2026-07-23T09:00:00.000Z",
      finishedAt: "2026-07-23T10:08:30.000Z",
    });
    expect(activityStatusLabel(completed, now, null)).toBe("Completed · 1m ago");
    expect(activityStatusLabel({ ...completed, status: "cancelled" }, now, null))
      .toBe("Stopped · 1m ago");
    expect(activityStatusLabel({ ...completed, status: "failed" }, now, null))
      .toBe("Failed · 1m ago");
  });

  it("groups only bounded, action-less operations under their owning agent", () => {
    const agent = run({
      id: "11111111-1111-4111-8111-111111111201",
      kind: "agent",
      actionId: null,
      label: "Codex · GPT-5",
      startedAt: "2026-07-23T10:00:00.000Z",
    });
    const operations = Array.from({ length: 6 }, (_, index) => run({
      id: `11111111-1111-4111-8111-${String(index + 300).padStart(12, "0")}`,
      kind: index % 2 === 0 ? "check" : "service",
      actionId: null,
      label: `Operation ${index + 1}`,
      status: index === 5 ? "running" : "succeeded",
      canStop: false,
      startedAt: `2026-07-23T10:00:0${index + 1}.000Z`,
      finishedAt: index === 5
        ? null
        : `2026-07-23T10:00:0${index + 1}.500Z`,
    }));
    const explicitAction = run({
      id: "11111111-1111-4111-8111-111111111401",
      actionId: "typecheck",
      label: "Explicit typecheck",
      startedAt: "2026-07-23T10:00:07.000Z",
    });
    const presentation = activityRunPresentation([
      agent,
      ...operations,
      explicitAction,
    ]);

    expect(presentation.sections.flatMap(({ runs }) => runs)
      .map(({ id }) => id)).toEqual([explicitAction.id, agent.id]);
    expect(presentation.operationsByAgentRun.get(agent.id)).toMatchObject({
      hiddenCount: 3,
      visible: [
        expect.objectContaining({ label: "Operation 4" }),
        expect.objectContaining({ label: "Operation 5" }),
        expect.objectContaining({ label: "Operation 6" }),
      ],
    });
    expect(presentation.summary).toEqual({
      attentionCount: 0,
      activeCount: 2,
    });
  });

  it("keeps independently running source-control work outside agent groups", () => {
    const agent = run({
      id: "11111111-1111-4111-8111-111111111451",
      kind: "agent",
      actionId: null,
      startedAt: "2026-07-23T10:00:00.000Z",
    });
    const sourceControl = run({
      id: "11111111-1111-4111-8111-111111111452",
      kind: "source-control",
      actionId: null,
      label: "Push changes",
      startedAt: "2026-07-23T10:00:02.000Z",
    });
    const presentation = activityRunPresentation([agent, sourceControl]);

    expect(presentation.operationsByAgentRun.get(agent.id)).toBeUndefined();
    expect(presentation.sections.flatMap(({ runs }) => runs))
      .toEqual([sourceControl, agent]);
    expect(presentation.summary).toEqual({
      attentionCount: 0,
      activeCount: 2,
    });
  });

  it("keeps failed operations independent so warnings and controls stay visible", () => {
    const agent = run({
      id: "11111111-1111-4111-8111-111111111501",
      kind: "agent",
      actionId: null,
      startedAt: "2026-07-23T10:00:00.000Z",
    });
    const failure = run({
      id: "11111111-1111-4111-8111-111111111502",
      actionId: null,
      status: "failed",
      attentionState: "unseen",
      canStop: false,
      startedAt: "2026-07-23T10:00:02.000Z",
      finishedAt: "2026-07-23T10:00:03.000Z",
    });
    const presentation = activityRunPresentation([agent, failure]);
    expect(presentation.operationsByAgentRun.get(agent.id)).toBeUndefined();
    expect(presentation.sections[0]).toMatchObject({
      id: "earlier",
      runs: expect.arrayContaining([
        expect.objectContaining({ id: failure.id }),
      ]),
    });
    expect(presentation.summary).toEqual({
      attentionCount: 1,
      activeCount: 1,
    });
  });
});
