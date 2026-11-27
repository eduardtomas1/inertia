import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
  type CSSProperties,
  type JSX,
  type LazyExoticComponent,
  type RefObject,
} from "react";

import { ChatWorkspace } from "./ChatWorkspace";
import {
  CheckoutBranchControlProvider,
  type CheckoutBranchControlModel,
} from "./CheckoutBranchControl";
import { ConversationDetailState } from "./ConversationDetailState";
import {
  DetachedConversationPlaceholder,
  type DetachedConversationPlaceholderProps,
} from "./DetachedConversationPlaceholder";
import { PaneResizeHandle } from "./PaneResizeHandle";
import { WatcherDockHost } from "./watcher/WatcherDockHost";
import type { SettingsViewProps } from "./settings/settingsTypes";
import { LoadingMark } from "./ui";
import type { Project } from "@shared/contracts";
import type { WorkspaceMediaPreviewTarget } from "@shared/workspace-media-preview";
import type { WorkspacePanelProps, WorkspacePanelTab } from "./WorkspacePanel";
import type { UsageSurfaceProps } from "./UsageSurface";
import type { AttachmentsSurfaceProps } from "./AttachmentsSurface";
import type { BackgroundTasksSurfaceProps } from "./BackgroundTasksSurface";
import type { WorkspaceRunsModel } from "../utils/workspaceRuns";
import { useChatMinimumHeight } from "../hooks/useChatMinimumHeight";
import { useLoadedSurface } from "../hooks/useLoadedSurface";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import type { SplitLayout, SplitPaneOwner } from "../utils/splitLayout";
import type { WorkspacePreviewOwner } from "../utils/workspacePreviewFocus";
import {
  loadConversationSplitView,
  loadBackgroundTasksSurface,
  loadAttachmentsSurface,
  loadFilesPanel,
  loadGoalPanel,
  loadHistoricalDiffPanel,
  loadPlanPanel,
  loadPreviewPanel,
  loadSettingsView,
  loadWorkspaceTerminal,
  loadUsageSurface,
  loadWorkspaceChangesPanel,
} from "./lazySurfaceLoaders";
import { createSurfaceLoader } from "../utils/surfaceLoader";
import type { TerminalPanelProps } from "./TerminalPanelSupport";

// Loaded here, not in lazySurfaceLoaders: the panel imports those loaders.
const loadWorkspacePanel = createSurfaceLoader(() => import("./WorkspacePanel"));

function lazySurface<TModule, TProps>(
  loader: () => Promise<TModule>,
  select: (module: TModule) => ComponentType<TProps>,
): LazyExoticComponent<ComponentType<TProps>> {
  return lazy(() => loader().then((module) => ({
    default: select(module),
  })));
}

const WorkspacePanel = lazySurface(
  loadWorkspacePanel,
  (module) => module.WorkspacePanel,
);
const UsageSurface = lazySurface(
  loadUsageSurface,
  (module) => module.UsageSurface,
);
const AttachmentsSurface = lazySurface(loadAttachmentsSurface, (module) => module.AttachmentsSurface);
const BackgroundTasksSurface = lazySurface(
  loadBackgroundTasksSurface,
  (module) => module.BackgroundTasksSurface,
);
const ConversationSplitView = lazySurface(
  loadConversationSplitView,
  (module) => module.ConversationSplitView,
);
const FilesPanel = lazySurface(loadFilesPanel, (module) => module.FilesPanel);
const HistoricalDiffPanel = lazySurface(
  loadHistoricalDiffPanel,
  (module) => module.HistoricalDiffPanel,
);
const GoalPanel = lazySurface(loadGoalPanel, (module) => module.GoalPanel);
const PlanPanel = lazySurface(loadPlanPanel, (module) => module.PlanPanel);
const PreviewPanel = lazySurface(
  loadPreviewPanel,
  (module) => module.PreviewPanel,
);
const WorkspaceChangesPanel = lazySurface(
  loadWorkspaceChangesPanel,
  (module) => module.WorkspaceChangesPanel,
);
const WorkspaceMediaPreviewDialog = lazy(
  () => import("./media/WorkspaceMediaPreviewDialog"),
);

function WorkspaceToolFallback(): JSX.Element {
  return (
    <div className="workspace-tool-loading" aria-busy="true">
      <LoadingMark label="Loading workspace tool" />
    </div>
  );
}

export interface WorkspaceToolScene {
  activeTool: WorkspacePanelTab | null;
  panel: Omit<WorkspacePanelProps, "children">;
  usage: UsageSurfaceProps;
  agents: BackgroundTasksSurfaceProps;
  attachments: AttachmentsSurfaceProps;
  runs: WorkspaceRunsModel;
  gitNotice: string | null;
  historicalDiff: ComponentProps<typeof HistoricalDiffPanel> | null;
  changes: ComponentProps<typeof WorkspaceChangesPanel>;
  files: ComponentProps<typeof FilesPanel>;
  filesKey: string;
  terminal: TerminalPanelProps;
  terminalKey: string;
  goal: ComponentProps<typeof GoalPanel>;
  plan: ComponentProps<typeof PlanPanel>;
  preview: Omit<ComponentProps<typeof PreviewPanel>, "owner">;
}

export interface ConversationPaneScene {
  detailState: ComponentProps<typeof ConversationDetailState> | null;
  chat: ComponentProps<typeof ChatWorkspace>;
  checkoutBranch?: CheckoutBranchControlModel | null;
  resizeHandle: ComponentProps<typeof PaneResizeHandle> | null;
  tools: WorkspaceToolScene | null;
}

export interface SplitPaneDetails {
  owner: SplitPaneOwner;
  conversationId: string;
  title: string;
  projectName: string;
  project?: Project | null;
  toolsOpen: boolean;
  onToggleTools: () => void;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  onOpenInWindow?: () => void;
  scene: ConversationPaneScene | null;
}

export interface WorkspaceSceneProps {
  view: "workspace" | "settings";
  detached?: boolean;
  settings: SettingsViewProps;
  detachedChat?: DetachedConversationPlaceholderProps | null;
  detailState: ComponentProps<typeof ConversationDetailState> | null;
  chat: ComponentProps<typeof ChatWorkspace>;
  checkoutBranch?: CheckoutBranchControlModel | null;
  splitScene?: {
    layout: SplitLayout;
    panes: SplitPaneDetails[];
    onLayoutChange: (layout: SplitLayout) => void;
    onClosePane: (owner: SplitPaneOwner) => void;
  } | null;
  resizeHandle: ComponentProps<typeof PaneResizeHandle> | null;
  tools: WorkspaceToolScene | null;
}

function WorkspacePanelFallback({
  presentation = "inline",
  visible = true,
}: Omit<WorkspacePanelProps, "children">): JSX.Element {
  return (
    <aside
      className={`workspace-panel is-${presentation}`}
      aria-label="Workspace tools"
      aria-busy="true"
      hidden={!visible}
    />
  );
}

function WorkspaceToolSurface({
  resizeHandle,
  tools,
  owner,
  terminalTarget,
  onPreviewMedia,
  detached = false,
}: Pick<ConversationPaneScene, "resizeHandle" | "tools"> & {
  owner: WorkspacePreviewOwner;
  terminalTarget: (node: HTMLDivElement | null) => void;
  onPreviewMedia?: (target: WorkspaceMediaPreviewTarget) => void;
  detached?: boolean;
}): JSX.Element {
  return (
    <>
      {resizeHandle && <PaneResizeHandle {...resizeHandle} />}
      {tools && (
        <Suspense fallback={<WorkspacePanelFallback {...tools.panel} />}>
          <WorkspacePanel {...tools.panel}>
            <Suspense fallback={<WorkspaceToolFallback />}>
              {tools.activeTool === "terminal" && <div ref={terminalTarget} className="terminal-surface-slot" />}
              {tools.activeTool === "attachments" && <AttachmentsSurface {...tools.attachments} />}
              {tools.activeTool === "usage" && (
                <UsageSurface {...tools.usage} />
              )}
              {tools.activeTool === "agents" && (
                <BackgroundTasksSurface key={tools.agents.conversationId ?? ""} {...tools.agents} />
              )}
              {tools.activeTool === "changes" && (
                tools.historicalDiff
                  ? <HistoricalDiffPanel {...tools.historicalDiff} />
                  : <WorkspaceChangesPanel {...tools.changes} />
              )}
              {tools.activeTool === "files" && (
                <FilesPanel
                  key={tools.filesKey}
                  {...tools.files}
                  onPreviewMedia={tools.files.onPreviewMedia ?? onPreviewMedia}
                />
              )}
              {tools.activeTool === "goal" && <GoalPanel {...tools.goal} />}
              {tools.activeTool === "plan" && (
                <PlanPanel
                  {...tools.plan}
                  markdown={tools.plan.markdown ? {
                    ...tools.plan.markdown,
                    ...(detached ? { projectBaseRoot: undefined } : {}),
                    onPreviewMedia: tools.plan.markdown.onPreviewMedia ?? onPreviewMedia,
                  } : undefined}
                />
              )}
              {tools.activeTool === "preview" && (
                <PreviewPanel owner={owner} {...tools.preview} />
              )}
            </Suspense>
          </WorkspacePanel>
        </Suspense>
      )}
    </>
  );
}

/** Defer terminal layout and xterm until this workspace first opens a terminal. */
function TerminalDock({
  tools,
  containerRef,
  surfaceTarget,
}: {
  tools: WorkspaceToolScene | null;
  containerRef: RefObject<HTMLDivElement | null>;
  surfaceTarget: HTMLDivElement | null;
}): JSX.Element | null {
  const activatedKeyRef = useRef<string | null>(null);
  if (tools?.terminal.visible) activatedKeyRef.current = tools.terminalKey;
  const activated = tools !== null && activatedKeyRef.current === tools.terminalKey;
  const WorkspaceTerminal = useLoadedSurface(loadWorkspaceTerminal, activated);
  if (!tools || !activated || !WorkspaceTerminal) return null;
  return (
    <WorkspaceTerminal
      terminal={tools.terminal}
      terminalKey={tools.terminalKey}
      inSurface={tools.activeTool === "terminal" && tools.panel.visible !== false}
      containerRef={containerRef}
      surfaceTarget={surfaceTarget}
    />
  );
}

function ConversationPane({
  detachedChat = null,
  detailState,
  chat,
  checkoutBranch = null,
  resizeHandle,
  tools,
  owner,
  onPreviewMedia,
  detached = false,
}: ConversationPaneScene & {
  owner: WorkspacePreviewOwner;
  detachedChat?: DetachedConversationPlaceholderProps | null;
  onPreviewMedia?: (target: WorkspaceMediaPreviewTarget) => void;
  detached?: boolean;
}): JSX.Element {
  const containerRef = resizeHandle?.containerRef as
    | RefObject<HTMLDivElement | null>
    | undefined;
  const chatRef = useRef<HTMLDivElement>(null);
  const [terminalTarget, setTerminalTarget] = useState<HTMLDivElement | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  useChatMinimumHeight(paneRef, chatRef);
  const style = resizeHandle
    ? {
        "--conversation-pane-tools-height": `${resizeHandle.value}px`,
      } as CSSProperties
    : undefined;
  return (
    <div
      ref={(node) => {
        paneRef.current = node;
        if (containerRef) containerRef.current = node;
      }}
      className={`conversation-pane-workspace${tools ? " has-tools" : ""}`}
      data-pane-owner={owner}
      style={style}
    >
      <div ref={chatRef} className="conversation-pane-chat">
        {detachedChat
          ? <DetachedConversationPlaceholder {...detachedChat} />
          : detailState
          ? <ConversationDetailState {...detailState} embedded />
          : (
            <CheckoutBranchControlProvider
              value={checkoutBranch
                ? { ...checkoutBranch, respondsToHeaderRequests: owner === "primary" }
                : null}
            >
              <ChatWorkspace
                {...chat}
                {...(detached ? { projectBaseRoot: undefined } : {})}
                onPreviewMedia={chat.onPreviewMedia ?? onPreviewMedia}
                embedded
              />
            </CheckoutBranchControlProvider>
          )}
        <TerminalDock tools={tools} containerRef={chatRef} surfaceTarget={terminalTarget} />
      </div>
      <WatcherDockHost watchedId={detachedChat || detailState ? null : chat.conversation?.id ?? null} />
      <WorkspaceToolSurface
        resizeHandle={resizeHandle}
        tools={tools}
        owner={owner}
        terminalTarget={setTerminalTarget}
        onPreviewMedia={onPreviewMedia}
        detached={detached}
      />
    </div>
  );
}

/**
 * Owns the workspace's view composition while App remains responsible for
 * controllers and state. Each child receives a complete, typed prop contract,
 * so scene changes do not grow another compressed JSX block in App.
 */
function WorkspaceSceneView({
  view,
  detached,
  settings,
  detachedChat = null,
  detailState,
  chat,
  checkoutBranch = null,
  splitScene = null,
  resizeHandle,
  tools,
}: WorkspaceSceneProps): JSX.Element {
  const SettingsView = useLoadedSurface(loadSettingsView, view === "settings");
  const chatColumnRef = useRef<HTMLDivElement>(null);
  const [terminalTarget, setTerminalTarget] = useState<HTMLDivElement | null>(null);
  const [previewMediaState, setPreviewMediaState] = useState<{
    readonly target: WorkspaceMediaPreviewTarget;
    readonly owner: WorkspacePreviewOwner;
    readonly originConversationId: string | null;
  } | null>(null);
  const previewMediaTarget = previewMediaState?.target ?? null;
  // Suspend any native Browser WebContentsView before the lazy dialog chunk loads.
  useNativePreviewSuspension(previewMediaTarget !== null);
  const isDetachedWindow = detached
    ?? (chat.conversationContextHandoffEnabled === false
      || Boolean(tools?.panel.hiddenSurfaces?.includes("preview")));

  const resolvePreviewPane = useCallback((
    state: {
      readonly target: WorkspaceMediaPreviewTarget;
      readonly owner: WorkspacePreviewOwner;
      readonly originConversationId: string | null;
    } | null,
    primaryChat: ComponentProps<typeof ChatWorkspace>,
    primaryDetachedChat: DetachedConversationPlaceholderProps | null,
    primaryDetailState: ComponentProps<typeof ConversationDetailState> | null,
    splitPanes: SplitPaneDetails[] | undefined,
  ): {
    readonly chat: ComponentProps<typeof ChatWorkspace>;
    readonly detachedChat: DetachedConversationPlaceholderProps | null;
    readonly detailState: ComponentProps<typeof ConversationDetailState> | null;
  } | null => {
    if (!state) return null;
    const matchesTarget = (candidate: ComponentProps<typeof ChatWorkspace>): boolean => {
      if (candidate.project?.id !== state.target.projectId) return false;
      if (state.target.conversationId) {
        return candidate.conversation?.id === state.target.conversationId;
      }
      return (candidate.conversation?.id ?? null) === state.originConversationId;
    };
    if (splitPanes) {
      const ownedPane = splitPanes.find((pane) => pane.owner === state.owner);
      if (!ownedPane) return null;
      const entry = ownedPane.scene
        ? {
            chat: ownedPane.scene.chat,
            detachedChat: null,
            detailState: ownedPane.scene.detailState,
          }
        : {
            chat: primaryChat,
            detachedChat: primaryDetachedChat,
            detailState: primaryDetailState,
          };
      return matchesTarget(entry.chat) ? entry : null;
    }
    if (state.owner !== "primary") return null;
    return matchesTarget(primaryChat)
      ? { chat: primaryChat, detachedChat: primaryDetachedChat, detailState: primaryDetailState }
      : null;
  }, []);

  const matchingPreviewPane = resolvePreviewPane(
    previewMediaState,
    chat,
    detachedChat,
    detailState,
    splitScene?.panes,
  );
  const matchingPreviewChat = matchingPreviewPane?.chat ?? null;
  const previewOwnerRef = useRef({
    state: previewMediaState,
    primaryChat: chat,
    primaryDetachedChat: detachedChat,
    primaryDetailState: detailState,
    splitPanes: splitScene?.panes,
  });
  previewOwnerRef.current = {
    state: previewMediaState,
    primaryChat: chat,
    primaryDetachedChat: detachedChat,
    primaryDetailState: detailState,
    splitPanes: splitScene?.panes,
  };

  useEffect(() => {
    if (!previewMediaState) return;
    if (
      view !== "workspace"
      || !matchingPreviewPane
      || matchingPreviewPane.detachedChat !== null
      || matchingPreviewPane.detailState !== null
    ) {
      setPreviewMediaState(null);
    }
  }, [matchingPreviewPane, previewMediaState, view]);

  const canShowMediaInFiles = Boolean(
    previewMediaTarget
    && matchingPreviewChat?.onOpenTurnFile
    && !(
      !previewMediaTarget.conversationId
      && matchingPreviewChat.conversation?.worktreePath
      && matchingPreviewChat.project?.normalizedPath
      && matchingPreviewChat.conversation.worktreePath !== matchingPreviewChat.project.normalizedPath
    ),
  );
  const openPreviewForOwner = useCallback(
    (owner: WorkspacePreviewOwner, target: WorkspaceMediaPreviewTarget) => {
      const { primaryChat, splitPanes } = previewOwnerRef.current;
      const ownedPane = splitPanes?.find((pane) => pane.owner === owner);
      const ownerChat = ownedPane?.scene ? ownedPane.scene.chat : primaryChat;
      setPreviewMediaState({
        owner,
        target,
        originConversationId: ownerChat.conversation?.id ?? null,
      });
    },
    [],
  );
  const onPrimaryPreviewMedia = useCallback(
    (target: WorkspaceMediaPreviewTarget) => openPreviewForOwner("primary", target),
    [openPreviewForOwner],
  );
  const panePreviewHandlers = useMemo(() => {
    const handlers = new Map<WorkspacePreviewOwner, (target: WorkspaceMediaPreviewTarget) => void>();
    for (const owner of ["primary", "secondary", "tertiary", "quaternary"] as const) {
      handlers.set(owner, (target) => openPreviewForOwner(owner, target));
    }
    return handlers;
  }, [openPreviewForOwner]);
  const onCloseMediaPreview = useCallback(() => {
    setPreviewMediaState(null);
  }, []);
  const onShowMediaInFiles = useCallback((relativePath: string) => {
    const {
      state,
      primaryChat,
      primaryDetachedChat,
      primaryDetailState,
      splitPanes,
    } = previewOwnerRef.current;
    const ownerPane = resolvePreviewPane(
      state,
      primaryChat,
      primaryDetachedChat,
      primaryDetailState,
      splitPanes,
    );
    ownerPane?.chat.onOpenTurnFile?.(relativePath);
    setPreviewMediaState(null);
  }, [resolvePreviewPane]);
  const onOpenMediaExternally = useCallback(async (target: WorkspaceMediaPreviewTarget) => {
    if (!window.inertia?.openProjectPath) {
      throw new Error("External file opener is unavailable.");
    }
    const result = await window.inertia.openProjectPath({
      projectId: target.projectId,
      ...(target.conversationId ? { conversationId: target.conversationId } : {}),
      relativePath: target.relativePath,
      action: "open-externally",
    });
    if (typeof result === "string" && result.trim().length > 0) {
      throw new Error(result.trim());
    }
  }, []);
  useChatMinimumHeight(chatColumnRef);
  return (
    <>
      {view === "settings" ? (
        SettingsView
          ? <SettingsView {...settings} />
          : <LoadingMark label="Loading settings" />
      ) : splitScene ? (
        <Suspense fallback={<LoadingMark label="Loading split view" />}>
        <ConversationSplitView
          layout={splitScene.layout}
          onLayoutChange={splitScene.onLayoutChange}
          onClosePane={splitScene.onClosePane}
          panes={splitScene.panes.map((pane) => ({
            ...pane,
            onOpenInWindow: pane.owner === "primary" && detachedChat?.windowOpen
              ? undefined
              : pane.onOpenInWindow,
            content: pane.scene ? (
              <ConversationPane
                owner={pane.owner}
                {...pane.scene}
                onPreviewMedia={panePreviewHandlers.get(pane.owner) ?? onPrimaryPreviewMedia}
                detached={isDetachedWindow}
              />
            ) : (
              <ConversationPane
                owner="primary"
                detachedChat={detachedChat}
                detailState={detailState}
                chat={chat}
                checkoutBranch={checkoutBranch}
                resizeHandle={resizeHandle}
                tools={tools}
                onPreviewMedia={onPrimaryPreviewMedia}
                detached={isDetachedWindow}
              />
            ),
          }))}
        />
        </Suspense>
      ) : (
        <div ref={chatColumnRef} className="workspace-chat-column">
          {detachedChat ? (
            <DetachedConversationPlaceholder {...detachedChat} />
          ) : detailState ? (
            <ConversationDetailState {...detailState} />
          ) : (
            <CheckoutBranchControlProvider
              value={checkoutBranch
                ? { ...checkoutBranch, respondsToHeaderRequests: true }
                : null}
            >
              <ChatWorkspace
                {...chat}
                {...(isDetachedWindow ? { projectBaseRoot: undefined } : {})}
                onPreviewMedia={chat.onPreviewMedia ?? onPrimaryPreviewMedia}
              />
            </CheckoutBranchControlProvider>
          )}
          <TerminalDock tools={tools} containerRef={chatColumnRef} surfaceTarget={terminalTarget} />
        </div>
      )}
      {view !== "settings" && !splitScene && (
        <WatcherDockHost watchedId={detachedChat || detailState ? null : chat.conversation?.id ?? null} />
      )}

      {!splitScene && (
        <WorkspaceToolSurface
          resizeHandle={resizeHandle}
          tools={tools}
          owner="primary"
          terminalTarget={setTerminalTarget}
          onPreviewMedia={onPrimaryPreviewMedia}
          detached={isDetachedWindow}
        />
      )}

      {previewMediaTarget !== null && (
        <Suspense fallback={null}>
          <WorkspaceMediaPreviewDialog
            target={previewMediaTarget}
            onClose={onCloseMediaPreview}
            onShowInFiles={canShowMediaInFiles ? onShowMediaInFiles : undefined}
            onOpenExternally={onOpenMediaExternally}
          />
        </Suspense>
      )}
    </>
  );
}

export const WorkspaceScene = memo(WorkspaceSceneView);
WorkspaceScene.displayName = "WorkspaceScene";

export type { WorkspacePanelTab };
