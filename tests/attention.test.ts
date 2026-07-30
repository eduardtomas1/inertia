import { describe, expect, it } from "vitest";

import {
  indexConversationWorkspaceRuns,
  selectConversationWorkspaceRun,
  workspaceRunAttentionView,
} from "../src/shared/attention";
import type { WorkspaceRun } from "../src/shared/contracts";

function run(overrides: Partial<WorkspaceRun> = {}): WorkspaceRun {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "agent",
    projectId: "22222222-2222-4222-8222-222222222222",
    conversationId: "33333333-3333-4333-8333-333333333333",
    actionId: null,
    label: "Agent run",
    detail: null,
    status: "succeeded",
    attentionState: "acknowledged",
    canStop: false,
    port: null,
    startedAt: "2026-07-23T10:00:00.000Z",
    finishedAt: "2026-07-23T10:01:00.000Z",
    ...overrides,
  };
}

describe("canonical workspace attention", () => {
  it("distinguishes unseen completion from an actionable failure", () => {
    expect(workspaceRunAttentionView(run({ attentionState: "unseen" }))).toMatchObject({
      bucket: "recent",
      needsAttention: false,
      unread: true,
      canMarkSeen: true,
    });
    expect(workspaceRunAttentionView(run({
      kind: "check",
      status: "failed",
      attentionState: "seen",
      finishedAt: null,
    }))).toMatchObject({
      bucket: "attention",
      needsAttention: true,
      unread: false,
      canMarkSeen: false,
      canAcknowledge: true,
    });
  });

  it("never lets a disposition hide or acknowledge an unresolved request", () => {
    for (const attentionState of ["acknowledged", "dismissed"] as const) {
      expect(workspaceRunAttentionView(run({
        status: "waiting",
        attentionState,
        finishedAt: null,
      }))).toMatchObject({
        bucket: "attention",
        reason: "waiting",
        needsAttention: true,
        canAcknowledge: false,
        canDismiss: false,
      });
    }
  });

  it("hides a dismissed operational row without deleting its history object", () => {
    const dismissed = run({ status: "failed", attentionState: "dismissed" });
    expect(workspaceRunAttentionView(dismissed)).toMatchObject({
      bucket: "hidden",
      needsAttention: false,
    });
    expect(dismissed).toMatchObject({ status: "failed", detail: null });
  });

  it("selects active work first and never resurfaces an older run after dismissal", () => {
    const older = run({
      id: "11111111-1111-4111-8111-111111111101",
      status: "failed",
      attentionState: "seen",
      startedAt: "2026-07-23T09:00:00.000Z",
    });
    const latest = run({
      id: "11111111-1111-4111-8111-111111111102",
      attentionState: "dismissed",
      startedAt: "2026-07-23T10:00:00.000Z",
    });
    expect(selectConversationWorkspaceRun(latest.conversationId!, [older, latest])).toBe(latest);

    const active = run({
      id: "11111111-1111-4111-8111-111111111103",
      status: "running",
      finishedAt: null,
      startedAt: "2026-07-23T08:00:00.000Z",
    });
    expect(selectConversationWorkspaceRun(latest.conversationId!, [older, latest, active])).toBe(active);
  });

  it("indexes canonical agent runs for many chats in one projection", () => {
    const firstConversation = run({
      id: "11111111-1111-4111-8111-111111111111",
      conversationId: "33333333-3333-4333-8333-333333333301",
      startedAt: "2026-07-23T10:00:00.000Z",
    });
    const secondConversationSettled = run({
      id: "11111111-1111-4111-8111-111111111112",
      conversationId: "33333333-3333-4333-8333-333333333302",
      startedAt: "2026-07-23T11:00:00.000Z",
    });
    const secondConversationActive = run({
      id: "11111111-1111-4111-8111-111111111113",
      conversationId: secondConversationSettled.conversationId,
      status: "running",
      finishedAt: null,
      startedAt: "2026-07-23T09:00:00.000Z",
    });
    const nonAgent = run({
      id: "11111111-1111-4111-8111-111111111114",
      kind: "check",
      conversationId: firstConversation.conversationId,
      startedAt: "2026-07-23T12:00:00.000Z",
    });

    const indexed = indexConversationWorkspaceRuns([
      firstConversation,
      secondConversationSettled,
      secondConversationActive,
      nonAgent,
    ]);

    expect(indexed.get(firstConversation.conversationId!))
      .toBe(firstConversation);
    expect(indexed.get(secondConversationSettled.conversationId!))
      .toBe(secondConversationActive);
  });
});
