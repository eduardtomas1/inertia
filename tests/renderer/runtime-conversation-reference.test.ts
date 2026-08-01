import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  runtimeConversationReference,
  visibleWorkspaceConversation,
} from "../../src/renderer/src/components/workspace-scene/createWorkspaceSceneModel";
import {
  draftWorkspaceToolsUnavailableReason,
} from "../../src/renderer/src/utils/draftWorkspaceAvailability";

const appSource = readFileSync(
  new URL("../../src/renderer/src/App.tsx", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const sceneSource = readFileSync(
  new URL(
    "../../src/renderer/src/components/workspace-scene/createWorkspaceSceneModel.ts",
    import.meta.url,
  ),
  "utf8",
);

describe("runtime conversation references", () => {
  it("omits renderer-only draft identities from runtime commands", () => {
    expect(runtimeConversationReference(null)).toEqual({});
  });

  it("includes identities that have been persisted by the runtime", () => {
    const conversation = {
      id: "22222222-2222-4222-8222-222222222222",
    };

    expect(runtimeConversationReference(conversation)).toEqual({
      conversationId: conversation.id,
    });
  });

  it("keeps a reconciling draft visible over its empty runtime shell", () => {
    const persisted = {
      id: "22222222-2222-4222-8222-222222222222",
    };
    const draft = {
      id: "33333333-3333-4333-8333-333333333333",
    };

    expect(visibleWorkspaceConversation(
      persisted as never,
      draft as never,
    )).toBe(draft);
    expect(visibleWorkspaceConversation(persisted as never, null))
      .toBe(persisted);
  });

  it("keeps unmaterialized isolated-worktree drafts away from project tools", () => {
    expect(draftWorkspaceToolsUnavailableReason(false)).toBeNull();
    expect(draftWorkspaceToolsUnavailableReason(true)).toBe(
      "Workspace tools are available after the first message creates this isolated worktree.",
    );
    expect(appSource).toContain("enabled: !workspaceToolsUnavailable");
    expect(appSource).toContain(
      "draftConversation: draftConversation.conversation,\n"
      + "    workspaceToolsUnavailable,",
    );
    expect(sceneSource).toContain(
      "tools: project && !workspaceToolsUnavailable ?",
    );
  });

  it("loads expensive workspace Git discovery only for visible Git surfaces", () => {
    expect(appSource).toContain(
      "loadGitStatusOnMount: !workspaceToolsUnavailable,",
    );
    expect(appSource).toContain(
      'sceneActiveTool === "changes"\n'
      + "          || workspaceLayout.environmentOpen",
    );
    expect(appSource).not.toContain(
      "loadGitOnMount: !workspaceToolsUnavailable,",
    );
  });
});
