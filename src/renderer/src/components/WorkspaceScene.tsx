import {
  memo,
  useRef,
  type ComponentProps,
  type CSSProperties,
  type JSX,
  type RefObject,
} from "react";

import { ChatWorkspace } from "./ChatWorkspace";
import { ConversationSplitView } from "./ConversationSplitView";
import { ConversationDetailState } from "./ConversationDetailState";
import { FilesPanel } from "./FilesPanel";
import { HistoricalDiffPanel } from "./HistoricalDiffPanel";
import { PaneResizeHandle } from "./PaneResizeHandle";
import { PlanPanel } from "./PlanPanel";
import { PreviewPanel } from "./PreviewPanel";
import { SettingsView } from "./SettingsView";
import { TerminalPanel } from "./TerminalPanel";
import { WorkspaceChangesPanel } from "./WorkspaceChangesPanel";
import { WorkspacePanel, type WorkspacePanelTab } from "./WorkspacePanel";

export interface WorkspaceToolScene {
  activeTool: WorkspacePanelTab | null;
  panel: Omit<ComponentProps<typeof WorkspacePanel>, "children">;
  historicalDiff: ComponentProps<typeof HistoricalDiffPanel> | null;
  changes: ComponentProps<typeof WorkspaceChangesPanel>;
  files: ComponentProps<typeof FilesPanel>;
  filesKey: string;
  terminal: ComponentProps<typeof TerminalPanel>;
  terminalKey: string;
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
  settings: ComponentProps<typeof SettingsView>;
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
    onTogglePrimaryTools: () => void;
    onToggleSecondaryTools: () => void;
    canMakeSecondaryPrimary?: boolean;
    makeSecondaryPrimaryUnavailableReason?: string;
    onMakeSecondaryPrimary: () => void;
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
          {tools.activeTool === "plan" && <PlanPanel {...tools.plan} />}
          {tools.activeTool === "preview" && (
            <PreviewPanel {...tools.preview} />
          )}
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
  return (
    <>
      {view === "settings" ? (
        <SettingsView {...settings} />
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
          onTogglePrimaryTools={splitScene.onTogglePrimaryTools}
          onToggleSecondaryTools={splitScene.onToggleSecondaryTools}
          canMakeSecondaryPrimary={splitScene.canMakeSecondaryPrimary}
          makeSecondaryPrimaryUnavailableReason={
            splitScene.makeSecondaryPrimaryUnavailableReason
          }
          onMakeSecondaryPrimary={splitScene.onMakeSecondaryPrimary}
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
