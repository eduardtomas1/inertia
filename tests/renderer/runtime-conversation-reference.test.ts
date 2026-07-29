import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  runtimeConversationReference,
} from "../../src/renderer/src/components/workspace-scene/createWorkspaceSceneModel";
import {
  draftWorkspaceToolsUnavailableReason,
} from "../../src/renderer/src/utils/draftWorkspaceAvailability";

const appSource = readFileSync(
  new URL("../../src/renderer/src/App.tsx", import.meta.url),
  "utf8",
);
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
});
