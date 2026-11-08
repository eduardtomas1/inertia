import { afterEach, describe, expect, it } from "vitest";

import {
  diffLayoutScopeFor,
  planImplementationLocation,
} from "../../src/renderer/src/components/workspace-scene/createWorkspaceSceneModel";
import { readComposerDraft } from "../../src/renderer/src/utils/composerDraftPersistence";
import { registerComposerPrefillTarget } from "../../src/renderer/src/utils/composerPrefill";
import {
  deliverNewChatDraft,
  newChatDraftTarget,
  pendingNewChatDraft,
} from "../../src/renderer/src/utils/newChatDraft";

afterEach(() => window.localStorage.clear());

describe("Implement in a new chat", () => {
  it("opens the new chat in the plan chat's worktree, or the project defaults", () => {
    expect(planImplementationLocation({ worktreePath: "/repo/.worktrees/feature", branch: "feature" }, "feature-2"))
      .toEqual({ kind: "worktree", branch: "feature-2", path: "/repo/.worktrees/feature" });
    expect(planImplementationLocation({ worktreePath: "/repo/.worktrees/feature", branch: "feature" }, null))
      .toEqual({ kind: "worktree", branch: "feature", path: "/repo/.worktrees/feature" });
    expect(planImplementationLocation({ worktreePath: null, branch: "main" }, "main")).toEqual({ kind: "defaults" });
    expect(planImplementationLocation(null, null)).toEqual({ kind: "defaults" });
  });

  it("waits for the new chat the request activates before placing its draft", () => {
    const before = { activeConversationId: "old", conversations: [{ id: "old", projectId: "project" }] };
    const pending = pendingNewChatDraft(before, "project", "Implement this plan.");
    expect(newChatDraftTarget(before, pending)).toBeNull();
    expect(newChatDraftTarget({
      activeConversationId: "other-project-chat",
      conversations: [...before.conversations, { id: "other-project-chat", projectId: "elsewhere" }],
    }, pending)).toBeNull();
    expect(newChatDraftTarget({
      activeConversationId: "new",
      conversations: [...before.conversations, { id: "new", projectId: "project" }],
    }, pending)).toBe("new");
    expect(newChatDraftTarget(null, pending)).toBeNull();
  });

  it("hands the draft to the open message box, or saves it for the box that opens next", () => {
    deliverNewChatDraft("closed-chat", "Implement this plan.");
    expect(readComposerDraft("closed-chat")).toBe("Implement this plan.");

    const received: string[] = [];
    const unregister = registerComposerPrefillTarget({
      conversationId: () => "open-chat",
      receive: (text) => received.push(text),
    });
    try {
      deliverNewChatDraft("open-chat", "Implement this plan.");
      expect(received).toEqual(["Implement this plan."]);
      expect(readComposerDraft("open-chat")).toBe("");
    } finally {
      unregister();
    }
  });
});

describe("diff layout scope", () => {
  it("gives each unsaved draft its own Unified or Split key", () => {
    expect(diffLayoutScopeFor("project", "chat", "draft-a")).toBe("project:chat");
    expect(diffLayoutScopeFor("project", null, "draft-a")).toBe("project:draft:draft-a");
    expect(diffLayoutScopeFor("project", null, "draft-b")).not.toBe(diffLayoutScopeFor("project", null, "draft-a"));
    expect(diffLayoutScopeFor("project", null, null)).toBe("project:draft");
  });
});
