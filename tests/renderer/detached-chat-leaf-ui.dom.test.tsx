import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConversationActionsMenu } from "../../src/renderer/src/components/ConversationActionsMenu";
import { ConversationSplitView } from "../../src/renderer/src/components/ConversationSplitView";
import { Sidebar } from "../../src/renderer/src/components/Sidebar";
import { WorkspaceHeader } from "../../src/renderer/src/components/WorkspaceHeader";
import { preserveDetachedDraftBeforeUnload } from "../../src/renderer/src/DetachedChatApp";
import { DetachedContextHandoffNotice } from "../../src/renderer/src/components/detached/detachedContextRequests";
import {
  defaultSettings,
  type AppSnapshot,
  type ConversationShell,
  type Project,
} from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

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
  modelSelection: providerNativeModelSelection({ providerId: "codex" }),
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
  it("cancels native close while the composer owns transient state", () => {
    const event = {
      preventDefault: vi.fn(),
      returnValue: "",
      stopImmediatePropagation: vi.fn(),
    };
    const persistDraft = vi.fn(() => true);
    const onBlocked = vi.fn();

    expect(preserveDetachedDraftBeforeUnload(
      event,
      {
        status: "blocked",
        blocker: "attachments",
        reason: "Remove attachments first.",
        draft: "owned draft",
      },
      persistDraft,
      onBlocked,
    )).toBe(false);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(event.returnValue).toBe("Remove attachments first.");
    expect(persistDraft).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledWith("Remove attachments first.");
  });

  it("cancels native close when durable draft persistence is not confirmed", () => {
    const event = {
      preventDefault: vi.fn(),
      returnValue: "",
      stopImmediatePropagation: vi.fn(),
    };
    const onBlocked = vi.fn();

    expect(preserveDetachedDraftBeforeUnload(
      event,
      { status: "ready", draft: "latest popup draft" },
      () => false,
      onBlocked,
    )).toBe(false);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(event.returnValue).toContain("draft could not be preserved");
    expect(onBlocked).toHaveBeenCalledWith(event.returnValue);
  });

  it("offers a dock-only handoff when the agent requests another chat", () => {
    const onReturnToMain = vi.fn();
    render(<DetachedContextHandoffNotice onReturnToMain={onReturnToMain} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Agent requested chat context",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Review this request in the main window.");
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Return to main" }));
    expect(onReturnToMain).toHaveBeenCalledOnce();
  });

  it("focuses an existing window from the conversation menu and blocks split ownership", () => {
    const onOpenConversationInWindow = vi.fn();
    const onArchiveConversation = vi.fn();
    const onDeleteConversation = vi.fn();
    render(
      <ConversationActionsMenu
        activeConversationId="33333333-3333-4333-8333-333333333333"
        activity={false}
        conversation={conversation}
        isDetached
        runs={[]}
        splitConversationIds={new Set()}
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
        onArchiveConversation={onArchiveConversation}
        onCloseConversationSplit={noOp}
        onDeleteConversation={onDeleteConversation}
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
    const split = screen.getByRole("menuitem", { name: "Add this chat to split view" });
    expect(split).toHaveAttribute("aria-disabled", "true");
    expect(split).not.toHaveAttribute("title");
    expect(split).toHaveAccessibleDescription("This chat is already open in its own window.");
    const archive = screen.getByRole("menuitem", { name: "Archive thread" });
    expect(archive).toHaveAttribute("aria-disabled", "true");
    expect(archive).toHaveAccessibleDescription("Return this chat to the main window before archiving it.");
    fireEvent.click(archive);
    expect(onArchiveConversation).not.toHaveBeenCalled();
    const remove = screen.getByRole("menuitem", { name: "Delete" });
    expect(remove).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(remove);
    expect(onDeleteConversation).not.toHaveBeenCalled();
  });

  it("says why Regenerate title is unavailable while a turn runs", () => {
    const onRegenerateTitle = vi.fn();
    const running = { ...conversation, status: "running" as const };
    render(
      <ConversationActionsMenu
        activeConversationId={running.id}
        activity={false}
        conversation={running}
        runs={[]}
        splitConversationIds={new Set()}
        thread={{
          conversation: running,
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
        onOpenConversationInWindow={noOp}
        onPinConversation={noOp}
        onRegenerateTitle={onRegenerateTitle}
        onRestoreConversation={noOp}
        onSetPopover={noOp}
        onSettleConversation={noOp}
        onSnoozeConversation={noOp}
        onStartRename={noOp}
      />,
    );

    const regenerate = screen.getByRole("menuitem", { name: "Regenerate title" });
    expect(regenerate).toHaveAttribute("aria-disabled", "true");
    expect(regenerate).toHaveAccessibleDescription("Available after the current turn finishes.");
    fireEvent.click(regenerate);
    expect(onRegenerateTitle).not.toHaveBeenCalled();
  });

  it("keeps focusing a detached chat available from the header title menu at the window limit", async () => {
    const onOpenConversationInWindow = vi.fn();
    render(
      <WorkspaceHeader
        project={project}
        conversation={conversation}
        view="workspace"
        sidebarCollapsed={false}
        gitStatus={null}
        branches={[]}
        actions={[]}
        busy={false}
        conversationMenu={{
          activeConversationId: conversation.id,
          detachedChatLimitReached: true,
          isDetached: true,
          runs: [],
          splitConversationIds: new Set(),
          onAcknowledgeRun: noOp,
          onArchiveConversation: noOp,
          onCloseConversationSplit: noOp,
          onDeleteConversation: noOp,
          onDismissRun: noOp,
          onOpenConversationInSplit: noOp,
          onOpenConversationInWindow,
          onPinConversation: noOp,
          onRestoreConversation: noOp,
          onSettleConversation: noOp,
          onSnoozeConversation: noOp,
        }}
        onOpenSidebar={noOp}
        onOpenSettings={noOp}
        onCloseSettings={noOp}
        onOpenFolder={noOp}
        onRevealFolder={noOp}
        onOpenFiles={noOp}
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

    fireEvent.click(screen.getByRole("button", { name: "Detachable ownership" }));
    const focus = await screen.findByRole("menuitem", { name: "Focus chat window" });
    expect(focus).toBeEnabled();
    fireEvent.click(focus);
    expect(onOpenConversationInWindow).toHaveBeenCalledWith(conversation);
  });

  it("opens either mounted split chat in its own window", () => {
    const openPrimary = vi.fn();
    const openSecondary = vi.fn();
    render(
      <ConversationSplitView
        layout={{
          axis: "columns",
          ratio: 50,
          first: { owner: "primary" },
          second: { owner: "secondary" },
        }}
        panes={[
          {
            owner: "primary",
            content: <span>Primary transcript</span>,
            title: "Primary routing",
            projectName: "Inertia",
            toolsOpen: false,
            onToggleTools: noOp,
            terminalOpen: false,
            onToggleTerminal: noOp,
            onOpenInWindow: openPrimary,
          },
          {
            owner: "secondary",
            content: <span>Secondary transcript</span>,
            title: "Secondary focus",
            projectName: "Desktop",
            toolsOpen: false,
            onToggleTools: noOp,
            terminalOpen: false,
            onToggleTerminal: noOp,
            onOpenInWindow: openSecondary,
          },
        ]}
        onLayoutChange={noOp}
        onClosePane={noOp}
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
    const onRemoveProject = vi.fn();
    const snapshot: AppSnapshot = {
      projects: [project],
      conversations: [conversation],
      runs: [],
      providers: [],
      activeProjectId: project.id,
      activeConversationId: conversation.id,
      settings: defaultSettings,
    };
    render(
      <Sidebar
        snapshot={snapshot}
        connectionStatus="online"
        view="workspace"
        open
        busy={false}
        projectScopeId={null}
        onProjectScopeChange={vi.fn()}
        layoutWidth={276}
        detachedConversationIds={new Set([conversation.id])}
        detachedChatLimitReached={false}
        splitConversationIds={new Set()}
        dailyWorkOpen={false}
        onClose={noOp}
        onViewChange={noOp}
        onOpenHome={noOp}
        onImportProject={noOp}
        onSelectConversation={onSelectConversation}
        onOpenConversationInSplit={noOp}
        onOpenConversationInWindow={noOp}
        onCloseConversationSplit={noOp}
        onCreateConversation={noOp}
        onChooseNewChatProject={noOp}
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
        onRemoveProject={onRemoveProject}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Earlier 1" }));
    const marker = screen.getByLabelText("Open in a separate chat window");
    expect(marker.closest(".activity-thread")).toHaveClass("is-detached");
    fireEvent.click(screen.getByRole("button", { name: "Filter work by project" }));
    fireEvent.click(screen.getByRole("button", {
      name: "Project actions for Inertia",
    }));
    const remove = screen.getByRole("menuitem", { name: "Remove project" });
    expect(remove).toHaveAttribute("aria-disabled", "true");
    expect(remove).not.toHaveAttribute("title");
    expect(remove).toHaveAccessibleDescription("Return this project's detached chats before removing it.");
    fireEvent.click(remove);
    expect(onRemoveProject).not.toHaveBeenCalled();
    fireEvent.click(marker.closest("button")!);
    expect(onSelectConversation).toHaveBeenCalledWith(conversation);
  });
});
