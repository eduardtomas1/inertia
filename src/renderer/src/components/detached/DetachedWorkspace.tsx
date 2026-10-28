import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { AppSettings } from "@shared/contracts";

import { detachedContextRequests, DetachedContextHandoffNotice } from "./detachedContextRequests";
import { DetachedChatHeader } from "./DetachedChatHeader";
import { DetachedUsageLimitsProvider } from "./DetachedUsageLimitsProvider";
import { DetachedChromeFallback, type DetachedWindowActionsProps } from "./DetachedWindowChrome";
import type { DetachedHandoff } from "./useDetachedHandoff";
import { useDetachedWorkspaceScene } from "./useDetachedWorkspaceScene";
import { ConversationDetailState } from "../ConversationDetailState";
import { LoadingMark } from "../ui";
import { WorkspaceScene } from "../WorkspaceScene";
import type { useInertiaConnection } from "../../hooks/useInertiaConnection";
import { useMarkRunSeen } from "../../hooks/useMarkRunSeen";

type Connection = ReturnType<typeof useInertiaConnection>;

export interface DetachedWorkspaceProps {
  conversationId: string;
  terminalHandoffIds: readonly string[];
  connection: Connection;
  settings: AppSettings;
  handoff: DetachedHandoff;
  platform: string;
  documentPresence: number;
  busyAction: string | null;
  setBusyAction: Dispatch<SetStateAction<string | null>>;
  setActionError: Dispatch<SetStateAction<string | null>>;
  windowActions: DetachedWindowActionsProps;
  onTerminalToggleChange: (toggle: (() => void) | null) => void;
}

export function DetachedWorkspace({
  conversationId,
  terminalHandoffIds,
  connection,
  settings,
  handoff,
  platform,
  documentPresence,
  busyAction,
  setBusyAction,
  setActionError,
  windowActions,
  onTerminalToggleChange,
}: DetachedWorkspaceProps): React.JSX.Element {
  const [cornerControlsWidth, setCornerControlsWidth] = useState(0);
  const workspace = useDetachedWorkspaceScene({
    conversationId,
    terminalHandoffIds,
    connection,
    settings,
    handoff,
    busyAction,
    setBusyAction,
    setActionError,
  });
  const { project, projection, layout, tools, scene, runtimeActions, request } = workspace;
  const conversation = projection.conversation;
  const toggleTerminal = layout.toggleTerminal;
  useEffect(() => {
    onTerminalToggleChange(toggleTerminal);
    return () => onTerminalToggleChange(null);
  }, [onTerminalToggleChange, toggleTerminal]);
  useMarkRunSeen({
    request,
    runs: connection.snapshot?.runs,
    conversationId,
    workspaceVisible: documentPresence > 0,
    latestContentVisible: workspace.latestContentVisible,
    obstructed: false,
    refresh: documentPresence,
  });
  const openInMain = handoff.openInMain;
  const openUsageLimits = useCallback(
    () => openInMain({ kind: "usage-limits" }),
    [openInMain],
  );
  const contextRequests = useMemo(
    () => detachedContextRequests(projection.pendingInputs),
    [projection.pendingInputs],
  );
  const namedContextRequestId = [...contextRequests.inputRequests].reverse().find(
    ({ conversationContextRequest }) => conversationContextRequest !== undefined,
  )?.id ?? null;
  const visibleScene = useMemo(() => ({
    ...scene,
    chat: {
      ...scene.chat,
      promptStashEnabled: false,
      conversationContextHandoffEnabled: false,
      agentContextRequestEnabled: true,
      contextSources: contextRequests.contextSources,
      inputRequests: contextRequests.inputRequests,
    },
  }), [contextRequests, scene]);
  const detailState = projection.detailState?.conversationId === conversationId
    ? projection.detailState
    : null;
  const unavailableDetail = detailState
    && detailState.state !== "loading"
    && detailState.state !== "ready"
      ? detailState
      : null;
  if (!conversation || !project || !connection.snapshot) {
    return (
      <DetachedChromeFallback title={conversation?.title ?? "Detached chat"} windowActions={windowActions}>
        {unavailableDetail ? (
          <ConversationDetailState
            embedded
            state={unavailableDetail.state}
            {...(unavailableDetail.state === "failed"
              ? { message: unavailableDetail.message }
              : {})}
            onRetry={projection.refreshDetail}
          />
        ) : !connection.snapshot ? (
          <div className="detached-chat-loading" aria-busy="true">
            <LoadingMark label="Connecting to chat" />
          </div>
        ) : (
          <ConversationDetailState
            embedded
            state="missing"
            onRetry={projection.refreshDetail}
          />
        )}
      </DetachedChromeFallback>
    );
  }
  const toolScene = scene.tools;
  const panelOpen = Boolean(toolScene && layout.toolsVisible);
  const inlinePanel = panelOpen && layout.panelPresentation === "inline";
  const sheetPanel = panelOpen && layout.panelPresentation === "sheet";
  const frameStyle = {
    ...layout.workspaceBodyStyle,
    "--workspace-corner-controls-width": `${cornerControlsWidth}px`,
  } as CSSProperties;
  return (
    <DetachedUsageLimitsProvider request={request} status={connection.status} onOpen={openUsageLimits}>
      <div
        ref={layout.appShellRef}
        className={`workspace-frame has-corner-controls${inlinePanel ? " has-right-panel" : ""}${sheetPanel ? " has-right-sheet" : ""}`}
        style={frameStyle}
      >
        <DetachedChatHeader
          platform={platform}
          project={project}
          conversation={projection.detail?.conversation ?? conversation}
          settings={settings}
          runs={connection.snapshot.runs}
          busyAction={busyAction}
          toolScene={toolScene}
          tools={tools}
          layout={layout}
          activity={workspace.activityActions}
          handoff={handoff}
          run={runtimeActions.run}
          openProjectPath={runtimeActions.openProjectPath}
          setActionError={setActionError}
          onCornerControlsWidthChange={setCornerControlsWidth}
          {...windowActions}
        />
        {contextRequests.mainWindowReviewPending && (
          <DetachedContextHandoffNotice onReturnToMain={handoff.dockInMain} />
        )}
        {namedContextRequestId && (
          <p key={namedContextRequestId} className="visually-hidden" role="status" aria-live="polite">
            The agent asked to read another chat.
          </p>
        )}
        <div
          ref={layout.workspaceBodyRef}
          id="workspace-content"
          data-view="workspace"
          className={`workspace-body${inlinePanel ? " has-tools" : ""}${sheetPanel ? " has-tools-sheet" : ""}`}
        >
          <WorkspaceScene {...visibleScene} />
        </div>
      </div>
    </DetachedUsageLimitsProvider>
  );
}
