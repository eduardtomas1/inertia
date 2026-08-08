import {
  lazy,
  memo,
  Suspense,
  useRef,
  type ComponentProps,
  type CSSProperties,
  type JSX,
  type RefObject,
} from "react";

import { ChatWorkspace } from "./ChatWorkspace";
import { ConversationSplitView } from "./ConversationSplitView";
import { ConversationDetailState } from "./ConversationDetailState";
import { PaneResizeHandle } from "./PaneResizeHandle";
import type { SettingsViewProps } from "./SettingsView";
import { LoadingMark } from "./ui";
import { WorkspacePanel, type WorkspacePanelTab } from "./WorkspacePanel";
import { useLoadedSurface } from "../hooks/useLoadedSurface";
import {
  loadFilesPanel,
  loadGoalPanel,
  loadHistoricalDiffPanel,
  loadPlanPanel,
  loadPreviewPanel,
  loadSettingsView,
  loadTerminalPanel,
  loadWorkspaceChangesPanel,
} from "./lazySurfaceLoaders";

const FilesPanel = lazy(async () => ({
  default: (await loadFilesPanel()).FilesPanel,
}));
const HistoricalDiffPanel = lazy(async () => ({
  default: (await loadHistoricalDiffPanel()).HistoricalDiffPanel,
}));
const GoalPanel = lazy(async () => ({
  default: (await loadGoalPanel()).GoalPanel,
}));
const PlanPanel = lazy(async () => ({
  default: (await loadPlanPanel()).PlanPanel,
}));
const PreviewPanel = lazy(async () => ({
  default: (await loadPreviewPanel()).PreviewPanel,
}));
const TerminalPanel = lazy(async () => ({
  default: (await loadTerminalPanel()).TerminalPanel,
}));
const WorkspaceChangesPanel = lazy(async () => ({
  default: (await loadWorkspaceChangesPanel()).WorkspaceChangesPanel,
}));

function WorkspaceToolFallback(): JSX.Element {
  return (
    <div className="workspace-tool-loading" aria-busy="true">
      <LoadingMark label="Loading workspace tool" />
    </div>
  );
}

export interface WorkspaceToolScene {
  activeTool: WorkspacePanelTab | null;
  panel: Omit<ComponentProps<typeof WorkspacePanel>, "children">;
  historicalDiff: ComponentProps<typeof HistoricalDiffPanel> | null;
  changes: ComponentProps<typeof WorkspaceChangesPanel>;
  files: ComponentProps<typeof FilesPanel>;
  filesKey: string;
  terminal: ComponentProps<typeof TerminalPanel>;
  terminalKey: string;
  goal: ComponentProps<typeof GoalPanel>;
  plan: ComponentProps<typeof PlanPanel>;
  preview: ComponentProps<typeof PreviewPanel>;
}

export interface ConversationPaneScene {
  detailState: ComponentProps<typeof ConversationDetailState> | null;
  chat: ComponentProps<typeof ChatWorkspace>;
  resizeHandle: ComponentProps<typeof PaneResizeHandle> | null;
  tools: WorkspaceToolScene | null;
}

export interface WorkspaceSceneProps {
  view: "workspace" | "settings";
  settings: SettingsViewProps;
  detailState: ComponentProps<typeof ConversationDetailState> | null;
  chat: ComponentProps<typeof ChatWorkspace>;
  splitScene?: {
    secondary: ConversationPaneScene;
    primaryTitle: string;
    secondaryTitle: string;
    primaryProjectName: string;
    secondaryProjectName: string;
    primaryToolsOpen: boolean;
    secondaryToolsOpen: boolean;
    secondaryFirst: boolean;
    onTogglePrimaryTools: () => void;
    onToggleSecondaryTools: () => void;
    onSwapPanes: () => void;
    onCloseSecondary: () => void;
  } | null;
  resizeHandle: ComponentProps<typeof PaneResizeHandle> | null;
  tools: WorkspaceToolScene | null;
}

function WorkspaceToolSurface({
  resizeHandle,
  tools,
}: Pick<ConversationPaneScene, "resizeHandle" | "tools">): JSX.Element {
  const terminalLifecycleRef = useRef({
    key: null as string | null,
    activated: false,
  });
  if (terminalLifecycleRef.current.key !== (tools?.terminalKey ?? null)) {
    terminalLifecycleRef.current = {
      key: tools?.terminalKey ?? null,
      activated: tools?.activeTool === "terminal",
    };
  } else if (tools?.activeTool === "terminal") {
    terminalLifecycleRef.current.activated = true;
  }
  return (
    <>
      {resizeHandle && <PaneResizeHandle {...resizeHandle} />}
      {tools && (
        <WorkspacePanel {...tools.panel}>
          <Suspense fallback={<WorkspaceToolFallback />}>
            {tools.activeTool === "changes" && (
              tools.historicalDiff
                ? <HistoricalDiffPanel {...tools.historicalDiff} />
                : <WorkspaceChangesPanel {...tools.changes} />
            )}
            {tools.activeTool === "files" && (
              <FilesPanel key={tools.filesKey} {...tools.files} />
            )}
            {terminalLifecycleRef.current.activated && (
              <TerminalPanel key={tools.terminalKey} {...tools.terminal} />
            )}
            {tools.activeTool === "goal" && <GoalPanel {...tools.goal} />}
            {tools.activeTool === "plan" && <PlanPanel {...tools.plan} />}
            {tools.activeTool === "preview" && (
              <PreviewPanel {...tools.preview} />
            )}
          </Suspense>
        </WorkspacePanel>
      )}
    </>
  );
}

function ConversationPane({
  detailState,
  chat,
  resizeHandle,
  tools,
}: ConversationPaneScene): JSX.Element {
  const containerRef = resizeHandle?.containerRef as
    | RefObject<HTMLDivElement | null>
    | undefined;
  const style = resizeHandle
    ? {
        "--conversation-pane-tools-height": `${resizeHandle.value}px`,
      } as CSSProperties
    : undefined;
  return (
    <div
      ref={containerRef}
      className={`conversation-pane-workspace${tools ? " has-tools" : ""}`}
      style={style}
    >
      <div className="conversation-pane-chat">
        {detailState
          ? <ConversationDetailState {...detailState} embedded />
          : <ChatWorkspace {...chat} embedded />}
      </div>
      <WorkspaceToolSurface resizeHandle={resizeHandle} tools={tools} />
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
  detailState,
  chat,
  splitScene = null,
  resizeHandle,
  tools,
}: WorkspaceSceneProps): JSX.Element {
  const SettingsView = useLoadedSurface(loadSettingsView, view === "settings");
  return (
    <>
      {view === "settings" ? (
        SettingsView
          ? <SettingsView {...settings} />
          : <LoadingMark label="Loading settings" />
      ) : splitScene ? (
        <ConversationSplitView
          primary={(
            <ConversationPane
              detailState={detailState}
              chat={chat}
              resizeHandle={resizeHandle}
              tools={tools}
            />
          )}
          secondary={<ConversationPane {...splitScene.secondary} />}
          primaryTitle={splitScene.primaryTitle}
          secondaryTitle={splitScene.secondaryTitle}
          primaryProjectName={splitScene.primaryProjectName}
          secondaryProjectName={splitScene.secondaryProjectName}
          primaryToolsOpen={splitScene.primaryToolsOpen}
          secondaryToolsOpen={splitScene.secondaryToolsOpen}
          secondaryFirst={splitScene.secondaryFirst}
          onTogglePrimaryTools={splitScene.onTogglePrimaryTools}
          onToggleSecondaryTools={splitScene.onToggleSecondaryTools}
          onSwapPanes={splitScene.onSwapPanes}
          onCloseSecondary={splitScene.onCloseSecondary}
        />
      ) : detailState ? (
        <ConversationDetailState {...detailState} />
      ) : (
        <ChatWorkspace {...chat} />
      )}

      {!splitScene && (
        <WorkspaceToolSurface resizeHandle={resizeHandle} tools={tools} />
      )}
    </>
  );
}

export const WorkspaceScene = memo(WorkspaceSceneView);
WorkspaceScene.displayName = "WorkspaceScene";

export type { WorkspacePanelTab };
