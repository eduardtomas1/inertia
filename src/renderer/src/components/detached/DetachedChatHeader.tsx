import { lazy, Suspense, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { PanelTopOpen, Pin, PinOff, X } from "lucide-react";
import type {
  AppSettings,
  Conversation,
  Project,
  ServerEvent,
  WorkspaceRun,
} from "@shared/contracts";

import type { useActivityActions } from "../../hooks/useActivityActions";
import type { useWorkspaceLayout } from "../../hooks/useWorkspaceLayout";
import type { useWorkspaceTools } from "../../hooks/useWorkspaceTools";
import type { CommandWithoutId } from "../../lib/runtimeCommands";
import { rootGitMutationScope } from "../../utils/workspaceGit";
import { loadCommitDialog } from "../lazySurfaceLoaders";
import { IconButton } from "../ui";
import { WorkspaceHeader, type HeaderConversationMenu } from "../WorkspaceHeader";
import type { WorkspaceToolScene } from "../WorkspaceScene";
import { PanelLayoutControls } from "../workspace-header/PanelLayoutControls";
import { newChatTarget } from "./detachedTargets";
import type { DetachedHandoff } from "./useDetachedHandoff";

const RootCommitDialog = lazy(async () => ({
  default: (await loadCommitDialog()).RootCommitDialog,
}));
const PullRequestDialog = lazy(() => import("../PullRequestDialog"));

const NO_SPLITS: ReadonlySet<string> = new Set();
const NO_RUNS: readonly WorkspaceRun[] = [];
const ignoreConversation = (): void => undefined;

type ActivityActions = ReturnType<typeof useActivityActions>;
type WorkspaceLayout = ReturnType<typeof useWorkspaceLayout>;
type WorkspaceTools = ReturnType<typeof useWorkspaceTools>;

interface WindowActionsProps {
  alwaysOnTop: boolean;
  pinning: boolean;
  onToggleAlwaysOnTop: () => void;
  onDock: () => void;
  onClose: () => void;
}

function DetachedWindowActions({
  alwaysOnTop,
  pinning,
  onToggleAlwaysOnTop,
  onDock,
  onClose,
}: WindowActionsProps): React.JSX.Element {
  return (
    <>
      <IconButton
        className="corner-toggle"
        label={alwaysOnTop ? "Unpin chat window" : "Keep chat window on top"}
        aria-pressed={alwaysOnTop}
        disabled={pinning}
        onClick={onToggleAlwaysOnTop}
      >
        {alwaysOnTop ? <PinOff size={16} /> : <Pin size={16} />}
      </IconButton>
      <IconButton className="corner-toggle" label="Return chat to main window" onClick={onDock}>
        <PanelTopOpen size={16} />
      </IconButton>
      <IconButton className="corner-toggle" label="Close chat window" onClick={onClose}>
        <X size={16} />
      </IconButton>
    </>
  );
}

function FallbackCornerControls({
  children,
  onWidthChange,
}: {
  children: ReactNode;
  onWidthChange: (width: number) => void;
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (node) onWidthChange(Math.ceil(node.getBoundingClientRect().width));
  }, [onWidthChange]);
  return (
    <div ref={rootRef} className="workspace-corner-controls no-drag" data-panel-layout-controls>
      {children}
    </div>
  );
}

export interface DetachedChatHeaderProps extends WindowActionsProps {
  platform: string;
  title: string;
  project: Project | null;
  conversation: Conversation | null;
  settings: AppSettings;
  runs: readonly WorkspaceRun[] | undefined;
  busyAction: string | null;
  toolScene: WorkspaceToolScene | null;
  tools: WorkspaceTools;
  layout: WorkspaceLayout;
  activity: ActivityActions;
  handoff: DetachedHandoff;
  run: (key: string, command: CommandWithoutId, options?: { reportError?: boolean }) => Promise<ServerEvent>;
  openProjectPath: (request: Parameters<typeof window.inertia.openProjectPath>[0]) => void;
  setActionError: (message: string | null) => void;
  onCornerControlsWidthChange: (width: number) => void;
}

export function DetachedChatHeader({
  platform,
  title,
  project,
  conversation,
  settings,
  runs = NO_RUNS,
  busyAction,
  toolScene,
  tools,
  layout,
  activity,
  handoff,
  run,
  openProjectPath,
  setActionError,
  onCornerControlsWidthChange,
  ...windowActions
}: DetachedChatHeaderProps): React.JSX.Element {
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [pullRequestDialogOpen, setPullRequestDialogOpen] = useState(false);
  const controls = <DetachedWindowActions {...windowActions} />;
  if (!project || !conversation) {
    return (
      <>
        <header className="workspace-header drag-region">
          <div className="header-leading">
            <nav className="header-breadcrumb" aria-label="Chat breadcrumb">
              <div className="header-title-wrap">
                <h1><span className="header-title-text">{title}</span></h1>
              </div>
            </nav>
          </div>
        </header>
        <FallbackCornerControls onWidthChange={onCornerControlsWidthChange}>
          {controls}
        </FallbackCornerControls>
      </>
    );
  }
  const gitStatus = tools.gitStatus;
  const rootRepository = rootGitMutationScope(gitStatus);
  const updateConversation = (
    payload: Omit<Extract<CommandWithoutId, { type: "conversation.update" }>["payload"], "conversationId">,
  ): void => {
    void run("conversation.update", {
      type: "conversation.update",
      payload: { conversationId: conversation.id, ...payload },
    }).catch(() => undefined);
  };
  const runConversationCommand = (
    type: "conversation.settle" | "conversation.unsettle" | "conversation.mark-unread" | "conversation.regenerate-title",
  ): void => {
    void run(type, { type, payload: { conversationId: conversation.id } }).catch(() => undefined);
  };
  const conversationMenu: HeaderConversationMenu = {
    projectPath: project.path,
    onMarkUnread: () => runConversationCommand("conversation.mark-unread"),
    onRegenerateTitle: () => runConversationCommand("conversation.regenerate-title"),
    activeConversationId: conversation.id,
    isDetached: true,
    runs,
    splitConversationIds: NO_SPLITS,
    onAcknowledgeRun: activity.acknowledgeActivity,
    onArchiveConversation: ignoreConversation,
    onCloseConversationSplit: ignoreConversation,
    onDeleteConversation: ignoreConversation,
    onDismissRun: activity.dismissActivity,
    onPinConversation: (_thread, pinned) => updateConversation({ pinned }),
    onRestoreConversation: () => runConversationCommand("conversation.unsettle"),
    onSettleConversation: () => runConversationCommand("conversation.settle"),
    onSnoozeConversation: (_thread, snoozedUntil) => updateConversation({ snoozedUntil }),
  };
  const openCheckout = (action: "open-externally" | "reveal"): void => openProjectPath({
    projectId: project.id,
    conversationId: conversation.id,
    relativePath: ".",
    action,
  });
  const openPullRequest = (): void => {
    if (!rootRepository) {
      setActionError("Refresh repository status before opening a pull request.");
      return;
    }
    setPullRequestDialogOpen(true);
  };
  const mutateRemote = (type: "git.fetch" | "git.pull" | "git.push"): Promise<void> =>
    tools.mutateRemote(type);
  return (
    <>
      <WorkspaceHeader
        project={project}
        conversation={conversation}
        view="workspace"
        sidebarCollapsed={false}
        gitStatus={gitStatus}
        gitNotice={toolScene?.gitNotice ?? null}
        branches={tools.branches}
        branchesLoading={tools.branchesLoading}
        branchesError={tools.branchesError}
        actions={tools.projectActions}
        runs={toolScene?.runs ?? null}
        busy={Boolean(busyAction)}
        checkoutPath={conversation.worktreePath ?? project.path}
        conversationMenu={conversationMenu}
        onOpenSettings={ignoreConversation}
        onCloseSettings={ignoreConversation}
        onRenameConversation={(nextTitle) => updateConversation({ title: nextTitle })}
        onOpenFolder={() => openCheckout("open-externally")}
        onRevealFolder={() => openCheckout("reveal")}
        onOpenFiles={() => layout.openSurface("files")}
        onRefreshBranches={() => tools.loadBranches()}
        onSwitchBranch={(name, remote) => tools.mutateBranch("git.branch.switch", name, remote)}
        onCreateBranch={(name) => tools.mutateBranch("git.branch.create", name)}
        onCreateConversationOnBranch={(branch) =>
          handoff.openInMain(newChatTarget(project.id, { kind: "branch", branch }))}
        onCreateConversationInWorktree={() => {
          if (!conversation.worktreePath) return;
          handoff.openInMain(newChatTarget(project.id, {
            kind: "worktree",
            branch: gitStatus?.branch ?? conversation.branch,
            path: conversation.worktreePath,
          }));
        }}
        onCreateConversationInIsolatedWorktree={() =>
          handoff.openInMain(newChatTarget(project.id, { kind: "isolated-worktree" }))}
        onCommit={() => setCommitDialogOpen(true)}
        onOpenPullRequest={openPullRequest}
        onPushAndCreatePullRequest={() => {
          void mutateRemote("git.push").then(openPullRequest).catch(() => undefined);
        }}
        onFetch={() => { void mutateRemote("git.fetch").catch(() => undefined); }}
        onPull={() => { void mutateRemote("git.pull").catch(() => undefined); }}
        onPush={() => { void mutateRemote("git.push").catch(() => undefined); }}
        onRefreshGitStatus={() => { void tools.loadGit({ scope: "status" }).catch(() => undefined); }}
        onRunAction={activity.runProjectAction}
      />
      <PanelLayoutControls
        usage={toolScene?.usage.usage ?? null}
        terminalAvailable={Boolean(toolScene)}
        terminalOpen={layout.terminalOpen}
        terminalShortcutLabel={`${platform === "darwin" ? "⌘" : "Ctrl+"}${settings.keybindings["toggle-terminal"].toUpperCase()}`}
        rightPanelAvailable={Boolean(toolScene)}
        rightPanelOpen={Boolean(toolScene) && layout.panel.isOpen}
        activeBackgroundTaskCount={toolScene?.panel.activeBackgroundTaskCount ?? 0}
        onToggleTerminal={layout.toggleTerminal}
        onToggleRightPanel={layout.toggleWorkspaceTools}
        onOpenUsage={() => layout.openSurface("usage")}
        onWidthChange={onCornerControlsWidthChange}
      >
        {controls}
      </PanelLayoutControls>
      {commitDialogOpen && (
        <Suspense fallback={null}>
          <RootCommitDialog
            owner={`${project.id}:${conversation.id}`}
            revision={tools.commitReviewRevision}
            status={gitStatus}
            reviewStates={tools.reviewStates}
            busy={busyAction === "git.commit" || busyAction === "git.push"}
            loadReview={tools.loadCommitReview}
            discardReview={tools.discardCommitReview}
            onClose={() => setCommitDialogOpen(false)}
            onError={setActionError}
            onCommit={tools.commit}
          />
        </Suspense>
      )}
      {pullRequestDialogOpen && rootRepository && (
        <Suspense fallback={null}>
          <PullRequestDialog
            open
            initialTitle={conversation.title || gitStatus?.branch || "Pull request"}
            busy={busyAction === "git.pr.create" || busyAction === "git.pr.open"}
            projectId={project.id}
            conversationId={conversation.id}
            repositoryPath={rootRepository.repositoryPath}
            authorityRef={rootRepository.authorityRef}
            forge={gitStatus?.pullRequest?.forge ?? "github"}
            run={run}
            onClose={() => setPullRequestDialogOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}
