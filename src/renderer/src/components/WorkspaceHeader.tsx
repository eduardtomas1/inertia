import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  Ellipsis,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
} from "lucide-react";
import type {
  Conversation,
  GitBranchInfo,
  GitStatusSnapshot,
  Project,
  ProjectAction,
} from "@shared/contracts";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { useDismissibleMenu } from "../hooks/useDismissibleMenu";
import { useLoadedSurface } from "../hooks/useLoadedSurface";
import type { AppView } from "../appView";
import { navigateMenuItems } from "../utils/menuKeyboard";
import { sidebarThreadView } from "../utils/sidebarModel";
import type { WorkspaceRunsModel } from "../utils/workspaceRuns";
import { requestCheckoutBranchMenu } from "../utils/checkoutBranchMenu";
import type { ConversationActionsMenu as ConversationActionsMenuComponent } from "./ConversationActionsMenu";
import { ProjectIcon, ProjectName } from "./ProjectIcon";
import { loadThreadActions } from "./sidebar/threadActionLoader";
import { IconButton } from "./ui";

const WorkspaceBranchMenu = lazy(() => import("./WorkspaceBranchMenu"));
const WorkspaceHeaderActions = lazy(async () => ({
  default: (await import("./workspace-header/WorkspaceHeaderActions")).WorkspaceHeaderActions,
}));

export const HEADER_ACTIONS_COLLAPSE_WIDTH = 520;

export function headerActionsCollapsed(input: {
  containerWidth: number;
  compact: boolean;
}): boolean {
  return input.compact || input.containerWidth < HEADER_ACTIONS_COLLAPSE_WIDTH;
}

export function resolveRenameCommit(input: {
  readonly title: string;
  readonly originalTitle: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle) return { action: "noop" };
  return { action: "commit", title: trimmed };
}

export type HeaderConversationMenu = Omit<
  ComponentProps<typeof ConversationActionsMenuComponent>,
  | "anchor"
  | "initialSubmenu"
  | "activity"
  | "conversation"
  | "thread"
  | "onDismiss"
  | "onSetPopover"
  | "onStartRename"
>;

type WorkspaceHeaderProps = {
  project: Project | null;
  conversation: Conversation | null;
  isServerConversation?: boolean;
  view: AppView;
  sidebarCollapsed: boolean;
  compact?: boolean;
  gitStatus: GitStatusSnapshot | null;
  gitNotice?: string | null;
  branches: GitBranchInfo[];
  branchesLoading?: boolean;
  branchesError?: string | null;
  actions: ProjectAction[];
  runs?: WorkspaceRunsModel | null;
  busy: boolean;
  checkoutPath?: string | null;
  filesAvailable?: boolean;
  conversationMenu?: HeaderConversationMenu | null;
  onOpenSidebar: () => void;
  onOpenSettings: () => void;
  onCreateConversationInProject?: () => void;
  onRenameConversation?: (title: string) => void;
  onOpenFolder: () => void;
  onRevealFolder: () => void;
  onOpenFiles: () => void;
  onAddAction?: () => void;
  onRefreshBranches: () => void;
  onSwitchBranch: (name: string, remote?: boolean) => void | Promise<void>;
  onCreateBranch: (name: string) => void | Promise<void>;
  onCreateConversationOnBranch: (branch: string) => void;
  onCreateConversationInWorktree: () => void;
  onCreateConversationInIsolatedWorktree: () => void;
  onCommit: () => void;
  onOpenPullRequest: () => void;
  onPushAndCreatePullRequest?: () => void;
  onFetch?: () => void;
  onPull: () => void;
  onPush: () => void;
  onRefreshGitStatus?: () => void;
  onRunAction: (action: ProjectAction) => void;
};

export function WorkspaceHeader({
  project,
  conversation,
  isServerConversation = Boolean(conversation),
  view,
  sidebarCollapsed,
  compact = false,
  gitStatus,
  gitNotice = null,
  branches,
  branchesLoading,
  branchesError,
  actions,
  runs = null,
  busy,
  checkoutPath = null,
  filesAvailable = true,
  conversationMenu = null,
  onOpenSidebar,
  onOpenSettings,
  onCreateConversationInProject,
  onRenameConversation,
  onOpenFolder,
  onRevealFolder,
  onOpenFiles,
  onAddAction,
  onRefreshBranches,
  onSwitchBranch,
  onCreateBranch,
  onCreateConversationOnBranch,
  onCreateConversationInWorktree,
  onCreateConversationInIsolatedWorktree,
  onCommit,
  onOpenPullRequest,
  onPushAndCreatePullRequest,
  onFetch,
  onPull,
  onPush,
  onRefreshGitStatus,
  onRunAction,
}: WorkspaceHeaderProps): React.JSX.Element {
  const headerRef = useRef<HTMLElement>(null);
  const titleButtonRef = useRef<HTMLButtonElement | null>(null);
  const [headerWidth, setHeaderWidth] = useState(Number.POSITIVE_INFINITY);
  const collapsed = headerActionsCollapsed({ containerWidth: headerWidth, compact });
  const [titleAnchor, setTitleAnchor] = useState<{ x: number; y: number } | null>(null);
  const { menu, toggleMenu, dismissMenu, setMenuTrigger, setMenuPopover } =
    useDismissibleMenu<"overflow" | "title" | "branches">();
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const renameCommittedRef = useRef(false);
  const [actionsContainer] = useState(() => {
    const container = document.createElement("div");
    container.className = "header-actions-portal";
    return container;
  });
  const ConversationActionsMenu = useLoadedSurface(loadThreadActions, menu === "title");
  useNativePreviewSuspension(menu !== null);

  useLayoutEffect(() => {
    const node = headerRef.current;
    if (!node) return;
    const update = (): void => {
      const style = window.getComputedStyle(node);
      const width = node.clientWidth
        - (Number.parseFloat(style.paddingLeft) || 0)
        - (Number.parseFloat(style.paddingRight) || 0);
      setHeaderWidth(width > 0 ? width : Number.POSITIVE_INFINITY);
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    dismissMenu("context-change");
  }, [conversation?.id, dismissMenu, project?.id]);
  const gitRoot = gitStatus?.root ?? null;
  const openMenuRef = useRef(menu);
  openMenuRef.current = menu;
  useEffect(() => {
    if (openMenuRef.current === "branches") dismissMenu("context-change");
  }, [dismissMenu, gitRoot]);
  useEffect(() => {
    if (!collapsed && menu === "overflow") dismissMenu("context-change");
  }, [collapsed, dismissMenu, menu]);
  if (renaming && renaming.id !== conversation?.id) setRenaming(null);

  const mountInlineActions = useCallback((node: HTMLDivElement | null) => {
    if (node && !collapsed) node.appendChild(actionsContainer);
  }, [actionsContainer, collapsed]);
  const mountMenuActions = useCallback((node: HTMLDivElement | null) => {
    if (node && collapsed) node.appendChild(actionsContainer);
  }, [actionsContainer, collapsed]);

  const workspaceActions = view === "workspace" && project !== null;
  const showGit = workspaceActions && gitStatus?.isRepository === true;
  const presentation = collapsed ? "menu" : "toolbar";
  const closeOverflow = (): void => {
    if (menu === "overflow") dismissMenu("selection");
  };
  const openBranches = (): void => {
    if (requestCheckoutBranchMenu()) return;
    onRefreshBranches();
    if (menu !== "branches") toggleMenu("branches");
  };
  const title = view === "home"
    ? "New chat"
    : view === "settings"
      ? "Settings"
      : view === "usage"
        ? "Usage"
        : conversation?.title ?? project?.name ?? "Workspace";
  const showProjectCrumb = view === "workspace" && project !== null && conversation !== null;
  const titleMenuAvailable = view === "workspace"
    && conversation !== null
    && isServerConversation
    && conversationMenu !== null;

  const startRename = (): void => {
    if (!conversation || !onRenameConversation) return;
    renameCommittedRef.current = false;
    dismissMenu("context-change");
    setRenaming({ id: conversation.id, title: conversation.title });
  };
  const commitRename = (value: string): void => {
    setRenaming(null);
    if (!conversation || !onRenameConversation) return;
    const resolution = resolveRenameCommit({ title: value, originalTitle: conversation.title });
    if (resolution.action === "commit") onRenameConversation(resolution.title);
    window.requestAnimationFrame(() => titleButtonRef.current?.focus());
  };
  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      renameCommittedRef.current = true;
      commitRename(event.currentTarget.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      renameCommittedRef.current = true;
      setRenaming(null);
      window.requestAnimationFrame(() => titleButtonRef.current?.focus());
    }
  };
  const handleTitleDoubleClick = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if ((event.target as HTMLElement).closest("[data-thread-title-chevron]")) return;
    startRename();
  };

  const headerActions = workspaceActions ? (
    <Suspense fallback={null}>
      <WorkspaceHeaderActions
        key={`${project.id}:${conversation?.id ?? "draft"}`}
        presentation={presentation}
        projectId={project.id}
        projectName={project.name}
        actions={actions}
        runs={runs}
        checkoutPath={checkoutPath}
        filesAvailable={filesAvailable}
        gitStatus={showGit ? gitStatus : null}
        busy={busy}
        gitNotice={gitNotice}
        onRunAction={onRunAction}
        {...(onAddAction ? { onAddAction } : {})}
        onOpenFolder={onOpenFolder}
        onRevealFolder={onRevealFolder}
        onOpenFiles={onOpenFiles}
        onCommit={onCommit}
        onPush={onPush}
        onPull={onPull}
        {...(onFetch ? { onFetch } : {})}
        onOpenPullRequest={onOpenPullRequest}
        onPushAndCreatePullRequest={onPushAndCreatePullRequest ?? onPush}
        onOpenBranches={openBranches}
        {...(onRefreshGitStatus ? { onRefreshGitStatus } : {})}
        onRequestMenuClose={closeOverflow}
      />
    </Suspense>
  ) : null;

  return (
    <header ref={headerRef} className="workspace-header drag-region">
      <div className="header-leading no-drag">
        <IconButton label="Toggle project navigation" className="menu-button" aria-pressed={!sidebarCollapsed} onClick={onOpenSidebar}>
          {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </IconButton>
        <nav className="header-breadcrumb" aria-label="Chat breadcrumb">
          {showProjectCrumb && (
            <>
              {onCreateConversationInProject ? (
                <button
                  type="button"
                  className="header-breadcrumb-project"
                  aria-label={`New chat in ${project.name}`}
                  title={`New chat in ${project.name}`}
                  onClick={onCreateConversationInProject}
                >
                  <ProjectIcon project={project} size={14} />
                  <ProjectName project={project}>{project.name}</ProjectName>
                </button>
              ) : (
                <span className="header-breadcrumb-project">
                  <ProjectIcon project={project} size={14} />
                  <ProjectName project={project}>{project.name}</ProjectName>
                </span>
              )}
              <span className="header-breadcrumb-separator" aria-hidden="true">/</span>
            </>
          )}
          <div className="header-title-wrap">
            {renaming ? (
              <input
                autoFocus
                className="header-title-input"
                aria-label="Chat title"
                defaultValue={renaming.title}
                maxLength={200}
                onFocus={(event) => event.currentTarget.select()}
                onBlur={(event) => {
                  if (renameCommittedRef.current) return;
                  commitRename(event.currentTarget.value);
                }}
                onKeyDown={handleRenameKeyDown}
              />
            ) : (
              <h1>
                {titleMenuAvailable ? (
                  <button
                    ref={(node) => {
                      titleButtonRef.current = node;
                      setMenuTrigger("title", node);
                    }}
                    type="button"
                    className="header-title-button"
                    title="Chat actions · double-click to rename"
                    aria-haspopup="menu"
                    aria-expanded={menu === "title"}
                    aria-controls={conversation ? `conversation-actions-${conversation.id}` : undefined}
                    onClick={(event) => {
                      if (event.detail > 1) return;
                      const bounds = event.currentTarget.getBoundingClientRect();
                      setTitleAnchor({ x: bounds.left, y: bounds.bottom + 4 });
                      toggleMenu("title");
                    }}
                    onDoubleClick={handleTitleDoubleClick}
                    onKeyDown={(event) => {
                      if (event.key === "F2") {
                        event.preventDefault();
                        startRename();
                      }
                    }}
                  >
                    <span className="header-title-text">{title}</span>
                    <ChevronDown size={13} aria-hidden="true" data-thread-title-chevron className="header-title-chevron" />
                  </button>
                ) : (
                  <span className="header-title-text">{title}</span>
                )}
              </h1>
            )}
          </div>
        </nav>
      </div>

      <div className="header-trailing no-drag" data-chat-header-actions>
        {workspaceActions && (
          <>
            <div className="header-actions" ref={mountInlineActions} />
            <div className="header-overflow-anchor" hidden={!collapsed}>
              <IconButton
                ref={(node) => setMenuTrigger("overflow", node)}
                label="More header actions"
                className="header-overflow-button"
                aria-haspopup="menu"
                aria-expanded={menu === "overflow"}
                aria-controls="workspace-header-overflow-menu"
                onClick={() => toggleMenu("overflow")}
              >
                <Ellipsis size={16} />
              </IconButton>
              <div
                ref={(node) => setMenuPopover("overflow", node)}
                id="workspace-header-overflow-menu"
                className="header-popover header-overflow-popover"
                role="menu"
                aria-label="Header actions"
                hidden={!collapsed || menu !== "overflow"}
                onKeyDown={(event) => navigateMenuItems(event, '[role="menuitem"]')}
              >
                <div ref={mountMenuActions} className="header-actions-menu-host" />
              </div>
            </div>
            {createPortal(headerActions, actionsContainer)}
          </>
        )}
        {showGit && menu === "branches" && project && (
          <div
            ref={(node) => setMenuPopover("branches", node)}
            className="header-branch-anchor"
            data-header-menu="branch"
          >
            <Suspense fallback={<div className="header-popover" role="status">Loading branches…</div>}>
              <WorkspaceBranchMenu
                project={project}
                conversation={conversation}
                gitStatus={gitStatus}
                branches={branches}
                branchesLoading={branchesLoading}
                branchesError={branchesError}
                busy={busy}
                onClose={() => dismissMenu("selection")}
                onRefreshBranches={onRefreshBranches}
                onSwitchBranch={onSwitchBranch}
                onCreateBranch={onCreateBranch}
                onCreateConversationInWorktree={onCreateConversationInWorktree}
                onCreateConversationOnBranch={onCreateConversationOnBranch}
                onCreateConversationInIsolatedWorktree={onCreateConversationInIsolatedWorktree}
              />
            </Suspense>
          </div>
        )}
        {view === "settings" ? (
          <IconButton label="Settings" aria-current="page" onClick={onOpenSettings}><Settings size={17} /></IconButton>
        ) : view !== "workspace" ? (
          <IconButton label="Open settings" onClick={onOpenSettings}><Settings size={17} /></IconButton>
        ) : null}
      </div>
      {menu === "title" && ConversationActionsMenu && conversation && conversationMenu && (
        <ConversationActionsMenu
          {...conversationMenu}
          {...(titleAnchor ? { anchor: titleAnchor } : {})}
          activity={false}
          conversation={conversation}
          thread={sidebarThreadView(conversation, conversationMenu.activeConversationId)}
          onDismiss={(reason) => dismissMenu(reason)}
          onSetPopover={(node) => setMenuPopover("title", node)}
          onStartRename={startRename}
        />
      )}
    </header>
  );
}
