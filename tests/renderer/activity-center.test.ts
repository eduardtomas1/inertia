import { describe, expect, it } from "vitest";

import {
  activityRunActions,
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

describe("Activity Center control model", () => {
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
