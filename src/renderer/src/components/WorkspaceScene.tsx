import {
  lazy,
  memo,
  Suspense,
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
import type { SettingsViewProps } from "./SettingsView";
import { LoadingMark } from "./ui";
import type { Project } from "@shared/contracts";
import type { WorkspacePanelProps, WorkspacePanelTab } from "./WorkspacePanel";
import type { UsageSurfaceProps } from "./UsageSurface";
import type { AttachmentsSurfaceProps } from "./AttachmentsSurface";
import type { AgentsSurfaceProps } from "./AgentsSurface";
import type { WorkspaceRunsModel } from "../utils/workspaceRuns";
import { useChatMinimumHeight } from "../hooks/useChatMinimumHeight";
import { useLoadedSurface } from "../hooks/useLoadedSurface";
import type { SplitLayout, SplitPaneOwner } from "../utils/splitLayout";
import type { WorkspacePreviewOwner } from "../utils/workspacePreviewFocus";
import {
  loadConversationSplitView,
  loadAgentsSurface,
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
const AgentsSurface = lazySurface(
  loadAgentsSurface,
  (module) => module.AgentsSurface,
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
const WorkspaceTerminal = lazySurface(
  loadWorkspaceTerminal,
  (module) => module.WorkspaceTerminal,
);
const WorkspaceChangesPanel = lazySurface(
  loadWorkspaceChangesPanel,
  (module) => module.WorkspaceChangesPanel,
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
  agents: AgentsSurfaceProps;
  attachments: AttachmentsSurfaceProps;
  runs: WorkspaceRunsModel;
  gitNotice: string | null;
  historicalDiff: ComponentProps<typeof HistoricalDiffPanel> | null;
  changes: ComponentProps<typeof WorkspaceChangesPanel>;
  files: ComponentProps<typeof FilesPanel>;
  filesKey: string;
  terminal: ComponentProps<typeof WorkspaceTerminal>["terminal"];
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
}: Pick<ConversationPaneScene, "resizeHandle" | "tools"> & {
  owner: WorkspacePreviewOwner;
  terminalTarget: (node: HTMLDivElement | null) => void;
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
                <AgentsSurface {...tools.agents} />
              )}
              {tools.activeTool === "changes" && (
                tools.historicalDiff
                  ? <HistoricalDiffPanel {...tools.historicalDiff} />
                  : <WorkspaceChangesPanel {...tools.changes} />
              )}
              {tools.activeTool === "files" && (
                <FilesPanel key={tools.filesKey} {...tools.files} />
              )}
              {tools.activeTool === "goal" && <GoalPanel {...tools.goal} />}
              {tools.activeTool === "plan" && <PlanPanel {...tools.plan} />}
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
  if (!tools || activatedKeyRef.current !== tools.terminalKey) return null;
  return (
    <Suspense fallback={null}>
      <WorkspaceTerminal
        terminal={tools.terminal}
        terminalKey={tools.terminalKey}
        inSurface={tools.activeTool === "terminal" && tools.panel.visible !== false}
        containerRef={containerRef}
        surfaceTarget={surfaceTarget}
      />
    </Suspense>
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
}: ConversationPaneScene & {
  owner: WorkspacePreviewOwner;
  detachedChat?: DetachedConversationPlaceholderProps | null;
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
              <ChatWorkspace {...chat} embedded />
            </CheckoutBranchControlProvider>
          )}
        <TerminalDock tools={tools} containerRef={chatRef} surfaceTarget={terminalTarget} />
      </div>
      <WorkspaceToolSurface
        resizeHandle={resizeHandle}
        tools={tools}
        owner={owner}
        terminalTarget={setTerminalTarget}
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
              <ConversationPane owner={pane.owner} {...pane.scene} />
            ) : (
              <ConversationPane
                owner="primary"
                detachedChat={detachedChat}
                detailState={detailState}
                chat={chat}
                checkoutBranch={checkoutBranch}
                resizeHandle={resizeHandle}
                tools={tools}
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
              <ChatWorkspace {...chat} />
            </CheckoutBranchControlProvider>
          )}
          <TerminalDock tools={tools} containerRef={chatColumnRef} surfaceTarget={terminalTarget} />
        </div>
      )}

      {!splitScene && (
        <WorkspaceToolSurface
          resizeHandle={resizeHandle}
          tools={tools}
          owner="primary"
          terminalTarget={setTerminalTarget}
        />
      )}
    </>
  );
}

export const WorkspaceScene = memo(WorkspaceSceneView);
WorkspaceScene.displayName = "WorkspaceScene";

export type { WorkspacePanelTab };
