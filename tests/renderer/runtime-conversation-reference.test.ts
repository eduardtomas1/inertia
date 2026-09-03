import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  runtimeConversationReference,
  terminalResumeDirectory,
  visibleChatConversation,
  visibleConversationLatestTurnSummary,
  visibleWorkspaceConversation,
  workspaceDirectoryIdentity,
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

  it("matches provider-resume directories across Windows path spelling", () => {
    expect(workspaceDirectoryIdentity("C:\\Work\\Project\\")).toBe(
      workspaceDirectoryIdentity("c:/work/project"),
    );
    expect(workspaceDirectoryIdentity("/Work/Project")).not.toBe(
      workspaceDirectoryIdentity("/work/project"),
    );
  });

  it("uses the visible draft project directory for provider resume choices", () => {
    expect(terminalResumeDirectory(
      { worktreePath: null },
      { normalizedPath: "/workspace/inertia" },
    )).toBe("/workspace/inertia");
    expect(terminalResumeDirectory(
      { worktreePath: "/workspace/inertia/.worktrees/draft" },
      { normalizedPath: "/workspace/inertia" },
    )).toBe("/workspace/inertia/.worktrees/draft");
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

  it("does not relabel a persisted shell turn as draft-owned", () => {
    const persisted = { id: "persisted-conversation" };
    const draft = { id: "renderer-draft" };
    const summary = { id: "persisted-turn" };

    expect(visibleConversationLatestTurnSummary(
      persisted,
      draft,
      summary as never,
    )).toBeNull();
    expect(visibleConversationLatestTurnSummary(
      persisted,
      persisted,
      summary as never,
    )).toBe(summary);
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
    expect(sceneSource).toContain("tools: project ?");
    expect(sceneSource).toContain('{ tabs: ["environment"] as const }');
    expect(sceneSource).toContain("gitLoading: workspaceTools.gitLoading");
    expect(sceneSource).toContain("gitError: workspaceTools.gitError");
  });

  it("loads expensive workspace Git discovery only for visible Git surfaces", () => {
    expect(appSource).toContain(
      "loadGitStatusOnMount: !workspaceToolsUnavailable,",
    );
    expect(appSource).toContain(
      'sceneActiveTool === "changes"\n'
      + '          || sceneActiveTool === "environment"',
    );
    expect(appSource).not.toContain(
      "loadGitOnMount: !workspaceToolsUnavailable,",
    );
  });

  it("keeps local drafts visible until route selection is authoritative", () => {
    const projectSelection = appSource.slice(
      appSource.indexOf("const selectProject ="),
      appSource.indexOf("const selectConversation ="),
    );
    const conversationSelection = appSource.slice(
      appSource.indexOf("const selectConversation ="),
      appSource.indexOf("const openConversationInSplit ="),
    );

    expect(projectSelection).not.toContain("clearDraftConversation");
    expect(conversationSelection).not.toContain("clearDraftConversation");
  });

  it("discards an abandoned draft only after a replacement chat is created", () => {
    const createConversation = appSource.slice(
      appSource.indexOf("const createConversation ="),
      appSource.indexOf("useGlobalShortcuts({"),
    );
    const discard = createConversation.indexOf("discardDraftConversation()");
    const createRequest = createConversation.indexOf(
      'conversationCreateQueue("conversation.create"',
    );

    expect(createRequest).toBeGreaterThan(-1);
    expect(discard).toBeGreaterThan(createRequest);
  });

  it("cancels judge handoff before route-created chat selection", () => {
    const routeCreation = appSource.slice(
      appSource.indexOf("const createConversationForSelection ="),
      appSource.indexOf("const respondToApproval ="),
    );
    const generationAdvance = routeCreation.indexOf(
      "conversationSelectionGenerationRef.current = selectionGeneration",
    );
    const createRequest = routeCreation.indexOf(
      'run("conversation.create"',
    );
    const selectionRequest = routeCreation.indexOf(
      "await selectConversationCommand(",
    );

    expect(generationAdvance).toBeGreaterThan(-1);
    expect(createRequest).toBeGreaterThan(generationAdvance);
    expect(selectionRequest).toBeGreaterThan(createRequest);
    expect(routeCreation.match(
      /selectionGeneration !== conversationSelectionGenerationRef\.current/g,
    )).toHaveLength(2);
  });

  it("routes every user command that can replace active workspace authority", () => {
    const authorityCommands = appSource.slice(
      appSource.indexOf("export function commandMayChangeWorkspaceAuthority"),
      appSource.indexOf("export default function App"),
    );
    for (const commandType of [
      "project.create",
      "project.select",
      "project.remove",
      "conversation.select",
      "conversation.create",
      "conversation.archive",
      "conversation.delete",
    ]) {
      expect(authorityCommands).toContain(`case "${commandType}"`);
    }
    expect(appSource).toContain("runNavigationCommand: runUserCommand");
    expect(appSource).toContain("run: runUserCommand,");
    expect(appSource).toContain(
      "sendMessage: sendMessageWithWorkspaceAuthority",
    );
    expect(appSource).toContain(
      "conversationSelectionGenerationRef.current += 1;",
    );
  });
});

describe("global chat draft visibility", () => {
  const draft = { id: "44444444-4444-4444-8444-444444444444" };
  const detail = { id: "55555555-5555-4555-8555-555555555555" };
  const fallback = { id: "66666666-6666-4666-8666-666666666666" };

  it("shows the draft even while a selected chat detail is loaded", () => {
    expect(visibleChatConversation(
      draft as never,
      detail as never,
      fallback as never,
    )).toBe(draft);
  });

  it("falls back to the loaded detail when no draft is open", () => {
    expect(visibleChatConversation(null, detail as never, fallback as never))
      .toBe(detail);
  });

  it("uses the persisted conversation when neither draft nor detail exists", () => {
    expect(visibleChatConversation(null, null, fallback as never))
      .toBe(fallback);
  });
});
