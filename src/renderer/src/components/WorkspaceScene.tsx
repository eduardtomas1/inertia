import type { ComponentProps, JSX } from "react";

import { ChatWorkspace } from "./ChatWorkspace";
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

interface WorkspaceToolScene {
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

export interface WorkspaceSceneProps {
  view: "workspace" | "settings";
  settings: ComponentProps<typeof SettingsView>;
  detailState: ComponentProps<typeof ConversationDetailState> | null;
  chat: ComponentProps<typeof ChatWorkspace>;
  resizeHandle: ComponentProps<typeof PaneResizeHandle> | null;
  tools: WorkspaceToolScene | null;
}

/**
 * Owns the workspace's view composition while App remains responsible for
 * controllers and state. Each child receives a complete, typed prop contract,
 * so scene changes do not grow another compressed JSX block in App.
 */
export function WorkspaceScene({
  view,
  settings,
  detailState,
  chat,
  resizeHandle,
  tools,
}: WorkspaceSceneProps): JSX.Element {
  return (
    <>
      {view === "settings" ? (
        <SettingsView {...settings} />
      ) : detailState ? (
        <ConversationDetailState {...detailState} />
      ) : (
        <ChatWorkspace {...chat} />
      )}

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
          <TerminalPanel key={tools.terminalKey} {...tools.terminal} />
          {tools.activeTool === "plan" && <PlanPanel {...tools.plan} />}
          {tools.activeTool === "preview" && <PreviewPanel {...tools.preview} />}
        </WorkspacePanel>
      )}
    </>
  );
}

export type { WorkspacePanelTab };
