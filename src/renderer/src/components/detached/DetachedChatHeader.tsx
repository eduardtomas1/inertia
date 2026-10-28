import { lazy, Suspense, useState } from "react";
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
import { WorkspaceHeader, type HeaderConversationMenu } from "../WorkspaceHeader";
import type { WorkspaceToolScene } from "../WorkspaceScene";
import { PanelLayoutControls } from "../workspace-header/PanelLayoutControls";
import { DetachedWindowActions, type DetachedWindowActionsProps } from "./DetachedWindowChrome";
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

export interface DetachedChatHeaderProps extends DetachedWindowActionsProps {
  platform: string;
  project: Project;
  conversation: Conversation;
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
    onCloseConversationSplit: ignoreConversation,
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
