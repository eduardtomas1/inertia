import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConversationActionsMenu } from "../../src/renderer/src/components/ConversationActionsMenu";
import { ConversationSplitView } from "../../src/renderer/src/components/ConversationSplitView";
import { Sidebar } from "../../src/renderer/src/components/Sidebar";
import { WorkspaceHeader } from "../../src/renderer/src/components/WorkspaceHeader";
import {
  defaultSettings,
  type AppSnapshot,
  type ConversationShell,
  type Project,
} from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Inertia",
  path: "/workspace/inertia",
  normalizedPath: "/workspace/inertia",
  repositoryIdentity: null,
  repositoryRoot: "/workspace/inertia",
  repositoryRelativePath: ".",
  groupingMode: null,
  gitRepositoryLimit: 128,
  color: "#5661d8",
  status: "ready",
  createdAt: "2026-08-20T08:00:00.000Z",
  updatedAt: "2026-08-20T08:00:00.000Z",
};

const conversation: ConversationShell = {
  id: "22222222-2222-4222-8222-222222222222",
  projectId: project.id,
  title: "Detachable ownership",
  providerId: "codex",
  modelSelection: nativeModelSelection({ providerId: "codex" }),
  continuationIdentity: null,
  model: "",
  reasoningEffort: "",
  interactionMode: "build",
  accessMode: "supervised",
  status: "idle",
  attentionKind: null,
  branch: null,
  worktreePath: null,
  providerSessionId: null,
  archivedAt: null,
  settledAt: null,
  completedAt: null,
  lastViewedAt: "2026-08-20T08:00:00.000Z",
  pinnedAt: null,
  snoozedUntil: null,
  createdAt: "2026-08-20T08:00:00.000Z",
  updatedAt: "2026-08-20T08:00:00.000Z",
  latestTurn: null,
  pendingApproval: false,
  pendingInput: false,
};

const noOp = (): void => undefined;

describe("detached chat leaf controls", () => {
  it("focuses an existing window from the conversation menu and blocks split ownership", () => {
    const onOpenConversationInWindow = vi.fn();
    render(
      <ConversationActionsMenu
        activeConversationId="33333333-3333-4333-8333-333333333333"
        activity={false}
        conversation={conversation}
        isDetached
        runs={[]}
        splitConversationId={null}
        thread={{
          conversation,
          run: null,
          status: "idle",
          needsAttention: false,
          unread: false,
          hidden: false,
          settled: false,
        }}
        onAcknowledgeRun={noOp}
        onArchiveConversation={noOp}
        onCloseConversationSplit={noOp}
        onDeleteConversation={noOp}
        onDismiss={noOp}
        onDismissRun={noOp}
        onOpenConversationInSplit={noOp}
        onOpenConversationInWindow={onOpenConversationInWindow}
        onPinConversation={noOp}
        onRestoreConversation={noOp}
        onSetPopover={noOp}
        onSettleConversation={noOp}
        onSnoozeConversation={noOp}
        onStartRename={noOp}
      />,
    );

    fireEvent.click(screen.getByRole("menuitem", {
      name: "Focus chat window",
    }));

    expect(onOpenConversationInWindow).toHaveBeenCalledWith(conversation);
    expect(screen.getByRole("menuitem", {
      name: "Add this chat to split view",
    })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeDisabled();
  });

  it("keeps the header focus control available when the window limit is reached", () => {
    const onOpenConversationInWindow = vi.fn();
    render(
      <WorkspaceHeader
        project={project}
        conversation={conversation}
        conversationDetached
        detachedChatLimitReached
        view="workspace"
        activeTool={null}
        sidebarCollapsed={false}
        theme="dark"
        gitStatus={null}
        branches={[]}
        actions={[]}
        busy={false}
        onOpenSidebar={noOp}
        onToggleTools={noOp}
        onOpenEnvironment={noOp}
        onCycleTheme={noOp}
        onOpenSettings={noOp}
        onOpenConnectionsSettings={noOp}
        onOpenProject={noOp}
        onOpenConversationInWindow={onOpenConversationInWindow}
        onRefreshBranches={noOp}
        onSwitchBranch={noOp}
        onCreateBranch={noOp}
        onCreateConversationOnBranch={noOp}
        onCreateConversationInWorktree={noOp}
        onCreateConversationInIsolatedWorktree={noOp}
        onCommit={noOp}
        onOpenPullRequest={noOp}
        onPull={noOp}
        onPush={noOp}
        onRunAction={noOp}
      />,
    );

    const focus = screen.getByRole("button", {
      name: "Focus chat window for Detachable ownership",
    });
    expect(focus).toBeEnabled();
    fireEvent.click(focus);
    expect(onOpenConversationInWindow).toHaveBeenCalledWith(conversation);
  });

  it("opens either mounted split chat in its own window", () => {
    const openPrimary = vi.fn();
    const openSecondary = vi.fn();
    render(
      <ConversationSplitView
        primary={<span>Primary transcript</span>}
        secondary={<span>Secondary transcript</span>}
        primaryTitle="Primary routing"
        secondaryTitle="Secondary focus"
        primaryProjectName="Inertia"
        secondaryProjectName="Desktop"
        primaryToolsOpen={false}
        secondaryToolsOpen={false}
        secondaryFirst={false}
        onTogglePrimaryTools={noOp}
        onToggleSecondaryTools={noOp}
        onSwapPanes={noOp}
        onCloseSecondary={noOp}
        onOpenPrimaryInWindow={openPrimary}
        onOpenSecondaryInWindow={openSecondary}
      />,
    );

    fireEvent.click(screen.getByRole("button", {
      name: "Open Primary routing in a new window",
    }));
    fireEvent.click(screen.getByRole("button", {
      name: "Open Secondary focus in a new window",
    }));

    expect(openPrimary).toHaveBeenCalledOnce();
    expect(openSecondary).toHaveBeenCalledOnce();
  });

  it("marks detached sidebar chats while preserving parent-owned row selection", () => {
    const onSelectConversation = vi.fn();
    const snapshot: AppSnapshot = {
      projects: [project],
      conversations: [conversation],
      runs: [],
      providers: [],
      activeProjectId: project.id,
      activeConversationId: conversation.id,
      settings: {
        ...defaultSettings,
        sidebarMode: "classic",
      },
    };
    render(
      <Sidebar
        snapshot={snapshot}
        connectionStatus="online"
        view="workspace"
        open
        busy={false}
        layoutWidth={276}
        detachedConversationIds={new Set([conversation.id])}
        detachedChatLimitReached={false}
        splitConversationId={null}
        dailyWorkOpen={false}
        onClose={noOp}
        onViewChange={noOp}
        onImportProject={noOp}
        onSelectProject={noOp}
        onSelectConversation={onSelectConversation}
        onOpenConversationInSplit={noOp}
        onOpenConversationInWindow={noOp}
        onCloseConversationSplit={noOp}
        onCreateConversation={noOp}
        onOpenMultiSpawn={noOp}
        onOpenDailyWork={noOp}
        onRenameConversation={noOp}
        onPinConversation={noOp}
        onSnoozeConversation={noOp}
        onArchiveConversation={noOp}
        onSettleConversation={noOp}
        onRestoreConversation={noOp}
        onDeleteConversation={noOp}
        onAcknowledgeRun={noOp}
        onDismissRun={noOp}
        onOpenProject={noOp}
        onRenameProject={noOp}
        onSetProjectGrouping={noOp}
        onSetProjectGitRepositoryLimit={noOp}
        onSidebarModeChange={noOp}
        onRemoveProject={noOp}
      />,
    );

    const marker = screen.getByLabelText("Open in a separate chat window");
    expect(marker.closest(".conversation-row")).toHaveClass("is-detached");
    fireEvent.click(screen.getByRole("button", {
      name: "Project actions for Inertia",
    }));
    expect(screen.getByRole("menuitem", { name: "Remove project" }))
      .toBeDisabled();
    fireEvent.click(marker.closest("button")!);
    expect(onSelectConversation).toHaveBeenCalledWith(conversation);
  });
});
