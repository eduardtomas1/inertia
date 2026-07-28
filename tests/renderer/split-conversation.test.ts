import { describe, expect, it, vi } from "vitest";

import {
  defaultSettings,
  type AppSnapshot,
  type ConversationShell,
} from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";
import {
  persistSplitConversationId,
  readSplitConversationId,
  resolvedSplitConversation,
  splitConversationAfterPrimaryChange,
} from "../../src/renderer/src/utils/splitConversation";

function conversation(
  id: string,
  projectId = "project-a",
  archivedAt: string | null = null,
): ConversationShell {
  return {
    id,
    projectId,
    title: id,
    providerId: "codex",
    model: "default",
    modelSelection: nativeModelSelection({
      providerId: "codex",
      modelId: "default",
      reasoningEffort: "medium",
    }),
    continuationIdentity: null,
    reasoningEffort: "medium",
    interactionMode: "build",
    accessMode: "supervised",
    branch: null,
    worktreePath: null,
    status: "idle",
    attentionKind: null,
    settledAt: null,
    archivedAt,
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
    completedAt: null,
    lastViewedAt: null,
    providerSessionId: null,
    latestTurn: null,
    pendingApproval: false,
    pendingInput: false,
  };
}

function snapshot(
  conversations: ConversationShell[],
  activeConversationId: string | null = conversations[0]?.id ?? null,
): AppSnapshot {
  return {
    projects: [],
    conversations,
    providers: [],
    backendProfiles: [],
    backendDefaults: [],
    runs: [],
    activeProjectId: conversations.find(
      ({ id }) => id === activeConversationId,
    )?.projectId ?? null,
    activeConversationId,
    settings: { ...defaultSettings },
  };
}

describe("split conversation selection", () => {
  it("keeps a distinct active conversation from any available project", () => {
    const primary = conversation("primary");
    const secondary = conversation("secondary");
    const otherProject = conversation("other", "project-b");
    const state = snapshot([primary, secondary, otherProject]);

    expect(resolvedSplitConversation(state, secondary.id)).toEqual(secondary);
    expect(resolvedSplitConversation(state, primary.id)).toBeNull();
    expect(resolvedSplitConversation(state, otherProject.id))
      .toEqual(otherProject);
  });

  it("drops archived, removed, and project-less split targets", () => {
    const primary = conversation("primary");
    const archived = conversation(
      "archived",
      "project-a",
      "2026-07-28T12:05:00.000Z",
    );

    expect(resolvedSplitConversation(snapshot([primary, archived]), archived.id))
      .toBeNull();
    expect(resolvedSplitConversation(snapshot([primary]), "missing"))
      .toBeNull();
    expect(resolvedSplitConversation(snapshot([primary], null), archived.id))
      .toBeNull();
  });

  it("swaps panes when the secondary chat becomes primary", () => {
    const primary = conversation("primary");
    const secondary = conversation("secondary");

    expect(splitConversationAfterPrimaryChange(
      primary,
      secondary,
      secondary,
    )).toBe(primary.id);
    expect(splitConversationAfterPrimaryChange(
      primary,
      conversation("third"),
      secondary,
    )).toBe(secondary.id);
    expect(splitConversationAfterPrimaryChange(
      primary,
      conversation("other", "project-b"),
      secondary,
    )).toBe(secondary.id);
  });

  it("persists and removes only the bounded layout identity", () => {
    const storage = {
      getItem: vi.fn(() => " secondary "),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };

    expect(readSplitConversationId(storage)).toBe("secondary");
    persistSplitConversationId(storage, "secondary");
    expect(storage.setItem).toHaveBeenCalledWith(
      "inertia:layout:split-conversation:v1",
      "secondary",
    );
    persistSplitConversationId(storage, null);
    expect(storage.removeItem).toHaveBeenCalledWith(
      "inertia:layout:split-conversation:v1",
    );
  });
});
