import { describe, expect, it } from "vitest";

import {
  shouldMarkWorkspaceRunSeen,
  workspaceAttentionObstructed,
} from "../../src/renderer/src/utils/attentionVisibility";
import type { WorkspaceRun } from "../../src/shared/contracts";

function run(overrides: Partial<WorkspaceRun> = {}): WorkspaceRun {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "agent",
    projectId: "22222222-2222-4222-8222-222222222222",
    conversationId: "33333333-3333-4333-8333-333333333333",
    actionId: null,
    label: "Background result",
    detail: null,
    status: "succeeded",
    attentionState: "unseen",
    canStop: false,
    port: null,
    startedAt: "2026-07-23T10:00:00.000Z",
    finishedAt: "2026-07-23T10:01:00.000Z",
    ...overrides,
  };
}

const visible = {
  documentVisible: true,
  documentFocused: true,
  workspaceVisible: true,
  latestContentVisible: true,
  obstructed: false,
};

describe("active transcript attention visibility", () => {
  it("marks only the unseen agent run belonging to the actually visible transcript", () => {
    const completed = run();
    expect(shouldMarkWorkspaceRunSeen(completed, completed.conversationId, visible)).toBe(true);
    expect(shouldMarkWorkspaceRunSeen(
      completed,
      "44444444-4444-4444-8444-444444444444",
      visible,
    )).toBe(false);
    expect(shouldMarkWorkspaceRunSeen(
      { ...completed, kind: "check" },
      completed.conversationId,
      visible,
    )).toBe(false);
    expect(shouldMarkWorkspaceRunSeen(
      { ...completed, attentionState: "seen" },
      completed.conversationId,
      visible,
    )).toBe(false);
  });

  it("does not infer a view from selection when focus, visibility, or viewport evidence is absent", () => {
    const completed = run();
    for (const key of [
      "documentVisible",
      "documentFocused",
      "workspaceVisible",
      "latestContentVisible",
    ] as const) {
      expect(shouldMarkWorkspaceRunSeen(
        completed,
        completed.conversationId,
        { ...visible, [key]: false },
      )).toBe(false);
    }
    expect(shouldMarkWorkspaceRunSeen(
      completed,
      completed.conversationId,
      { ...visible, obstructed: true },
    )).toBe(false);
  });

  it("treats the multi-spawn dialog as a completion obstruction", () => {
    const unobstructed = {
      environmentOpen: false,
      paletteOpen: false,
      commitDialogOpen: false,
      authProviderOpen: false,
      multiSpawnOpen: false,
      mobileSidebarOpen: false,
    };
    expect(workspaceAttentionObstructed(unobstructed)).toBe(false);
    expect(workspaceAttentionObstructed({
      ...unobstructed,
      multiSpawnOpen: true,
    })).toBe(true);
    expect(workspaceAttentionObstructed({
      ...unobstructed,
      environmentOpen: true,
    })).toBe(true);
    expect(shouldMarkWorkspaceRunSeen(
      run(),
      run().conversationId,
      {
        ...visible,
        obstructed: workspaceAttentionObstructed({
          ...unobstructed,
          multiSpawnOpen: true,
        }),
      },
    )).toBe(false);
  });
});
