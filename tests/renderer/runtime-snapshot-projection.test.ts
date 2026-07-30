import { describe, expect, it } from "vitest";

import {
  defaultSettings,
  type AppSnapshot,
  type ConversationShell,
  type WorkspaceRun,
} from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";
import { applyConversationShellEvent } from "../../src/renderer/src/utils/runtimeSnapshotProjection";

function conversation(id: string, updatedAt: string): ConversationShell {
  return {
    id,
    projectId: `${id}-project`,
    title: `Conversation ${id}`,
    providerId: "codex",
    modelSelection: nativeModelSelection({
      providerId: "codex",
      modelId: "default",
      reasoningEffort: "medium",
    }),
    continuationIdentity: null,
    model: "default",
    reasoningEffort: "medium",
    interactionMode: "build",
    accessMode: "supervised",
    status: "idle",
    attentionKind: null,
    branch: null,
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: updatedAt,
    completedAt: updatedAt,
    lastViewedAt: updatedAt,
    createdAt: "2026-07-30T10:00:00.000Z",
    updatedAt,
    latestTurn: null,
    pendingApproval: false,
    pendingInput: false,
  };
}

function run(
  id: string,
  conversationId: string,
  startedAt: string,
): WorkspaceRun {
  return {
    id,
    kind: "agent",
    projectId: `${conversationId}-project`,
    conversationId,
    actionId: null,
    label: `Run ${id}`,
    detail: null,
    status: "running",
    attentionState: "unseen",
    canStop: true,
    port: null,
    startedAt,
    finishedAt: null,
  };
}

describe("bounded conversation shell projection", () => {
  it("replaces only the affected conversation and its owned runs", () => {
    const primary = conversation("primary", "2026-07-30T10:00:00.000Z");
    const secondary = conversation("secondary", "2026-07-30T10:01:00.000Z");
    const secondaryRun = run(
      "secondary-run",
      secondary.id,
      "2026-07-30T10:01:00.000Z",
    );
    const snapshot: AppSnapshot = {
      projects: [],
      conversations: [secondary, primary],
      runs: [
        secondaryRun,
        run("old-primary-run", primary.id, "2026-07-30T10:00:00.000Z"),
      ],
      providers: [],
      settings: { ...defaultSettings },
      activeProjectId: primary.projectId,
      activeConversationId: primary.id,
    };
    const updatedPrimary = {
      ...primary,
      status: "running" as const,
      updatedAt: "2026-07-30T10:02:00.000Z",
    };
    const nextRun = run(
      "new-primary-run",
      primary.id,
      "2026-07-30T10:02:00.000Z",
    );

    const next = applyConversationShellEvent(snapshot, {
      type: "conversation.shell.updated",
      conversation: updatedPrimary,
      runs: [nextRun],
    });

    expect(next).not.toBe(snapshot);
    expect(next.projects).toBe(snapshot.projects);
    expect(next.providers).toBe(snapshot.providers);
    expect(next.conversations).toEqual([updatedPrimary, secondary]);
    expect(next.conversations[1]).toBe(secondary);
    expect(next.runs).toEqual([nextRun, secondaryRun]);
    expect(next.runs[1]).toBe(secondaryRun);
  });

  it("keeps the global shell run projection bounded", () => {
    const primary = conversation("primary", "2026-07-30T10:00:00.000Z");
    const snapshot: AppSnapshot = {
      projects: [],
      conversations: [primary],
      runs: Array.from({ length: 200 }, (_, index) =>
        run(
          `background-${index}`,
          `background-${index}`,
          new Date(Date.parse("2026-07-30T09:00:00.000Z") + index).toISOString(),
        )),
      providers: [],
      settings: { ...defaultSettings },
      activeProjectId: primary.projectId,
      activeConversationId: primary.id,
    };

    const next = applyConversationShellEvent(snapshot, {
      type: "conversation.shell.updated",
      conversation: primary,
      runs: [run("latest", primary.id, "2026-07-30T11:00:00.000Z")],
    });

    expect(next.runs).toHaveLength(200);
    expect(next.runs[0]?.id).toBe("latest");
  });
});
