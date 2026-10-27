import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  MessagesSquare,
  PanelTopOpen,
} from "lucide-react";
import type {
  AgentInputRequest,
  AppSettings,
} from "@shared/contracts";
import type { DesktopWindowContext } from "@shared/desktop";
import { detachedChatWindowTitle } from "@shared/desktop-window-title";
import { MAC_BRAND_SAFE_INSET } from "@shared/window-chrome";
import { applicationProductName } from "../../shared/workspace-image-preview";

import type { ConversationContextSourceOption } from "./components/conversation-context/types";
import { clearMessageSearchFocus, requestMessageSearchFocus } from "./utils/messageSearchFocus";
import "./detached-chat.css";
import { ConversationDetailState } from "./components/ConversationDetailState";
import { LoadingMark } from "./components/ui";
import { WorkspaceScene } from "./components/WorkspaceScene";
import { DetachedChatHeader } from "./components/detached/DetachedChatHeader";
import { DetachedUsageLimitsProvider } from "./components/detached/DetachedUsageLimitsProvider";
import { newChatTarget } from "./components/detached/detachedTargets";
import { useDetachedHandoff } from "./components/detached/useDetachedHandoff";
import { useDetachedShortcuts } from "./components/detached/useDetachedShortcuts";
import { useDetachedWorkspaceScene } from "./components/detached/useDetachedWorkspaceScene";
import { useDocumentPresence } from "./hooks/useDocumentPresence";
import { useInertiaConnection } from "./hooks/useInertiaConnection";
import { useStableController } from "./hooks/useStableController";
import { useTheme } from "./hooks/useTheme";
import { onComposerDraftPersisted, persistComposerDraft } from "./utils/composerDraftPersistence";
import { prepareComposerDetachment } from "./utils/composerOwnership";
import { applyInterfaceScale } from "./utils/interfaceScale";
import { cachedAppSettings } from "./utils/cachedSettings";
import { useMarkRunSeen } from "./hooks/useMarkRunSeen";
import { WorkingIndicatorProvider } from "./components/working-indicator/WorkingIndicatorContext";
import { WatcherContext } from "./components/watcher/watcherContext";
import { DuoJudgeNoticeContext } from "./components/DuoJudgeNoticeContext";
import { useDuoLaunchWatch } from "./hooks/useDuoLaunchWatch";
import { useWatcherSurfaceController } from "./hooks/useWatcherSurface";
import { HtmlRenderRuntimeStatusContext } from "./components/response-timeline/html-render-runtime";
import { loadResponseTimeline } from "./components/chatSurfaceLoaders";

type DetachedWindowContext = Extract<
  DesktopWindowContext,
  { role: "detached-chat" }
>;

interface DetachedChatAppProps {
  initialWindowContext: DetachedWindowContext;
}

interface DetachedChatBeforeUnloadEvent {
  preventDefault(): void;
  returnValue: string;
  stopImmediatePropagation(): void;
}

const DRAFT_PERSISTENCE_FAILURE =
  "This window stayed open because its draft could not be preserved.";
const NO_CONTEXT_SOURCES: readonly ConversationContextSourceOption[] = [];
const ignoreDuoStatusUpdate = (): void => undefined;

void loadResponseTimeline();

/** Keeps native close fail-closed around popup-only composer ownership. */
export function preserveDetachedDraftBeforeUnload(
  event: DetachedChatBeforeUnloadEvent,
  preparation: ReturnType<typeof prepareComposerDetachment>,
  persistDraft: (draft: string) => boolean,
  onBlocked: (reason: string) => void,
): boolean {
  const block = (reason: string): false => {
    event.preventDefault();
    event.returnValue = reason;
    event.stopImmediatePropagation();
    onBlocked(reason);
    return false;
  };
  if (preparation.status === "blocked") {
    return block(preparation.reason);
  }
  try {
    if (!persistDraft(preparation.draft)) {
      return block(DRAFT_PERSISTENCE_FAILURE);
    }
  } catch {
    return block(DRAFT_PERSISTENCE_FAILURE);
  }
  return true;
}

function publicError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export interface DetachedContextRequests {
  inputRequests: AgentInputRequest[];
  contextSources: readonly ConversationContextSourceOption[];
  mainWindowReviewPending: boolean;
}

export function detachedContextRequests(
  pendingInputs: AgentInputRequest[],
): DetachedContextRequests {
  const contextSources: ConversationContextSourceOption[] = [];
  const inputRequests = pendingInputs.filter((request) => {
    const context = request.conversationContextRequest;
    if (!context) return true;
    const source = context.requestedSource;
    if (
      !source
      || context.requestedSourceConversationId === null
      || source.conversationId !== context.requestedSourceConversationId
    ) return false;
    if (!contextSources.some(({ conversationId }) => conversationId === source.conversationId)) {
      contextSources.push({
        conversationId: source.conversationId,
        conversationTitle: source.conversationTitle,
        projectName: source.projectName,
        workspaceLabel: source.workspaceLabel,
        targetWorkspaceLabel: source.targetWorkspaceLabel,
        workspaceRelation: source.workspaceRelation,
        archived: false,
      });
    }
    return true;
  });
  const mainWindowReviewPending = inputRequests.length !== pendingInputs.length;
  return {
    inputRequests: mainWindowReviewPending ? inputRequests : pendingInputs,
    contextSources: contextSources.length > 0 ? contextSources : NO_CONTEXT_SOURCES,
    mainWindowReviewPending,
  };
}

export function DetachedContextHandoffNotice({
  onReturnToMain,
}: {
  onReturnToMain: () => void;
}): React.JSX.Element {
  return (
    <div
      className="pending-input-notice detached-chat-context-handoff"
      role="status"
      aria-live="polite"
    >
      <MessagesSquare size={14} aria-hidden="true" />
      <span>
        <strong>Agent requested chat context</strong>
        <small>Review this request in the main window.</small>
      </span>
      <button type="button" onClick={onReturnToMain}>
        <PanelTopOpen size={14} aria-hidden="true" />
        Return to main
      </button>
    </div>
  );
}

export default function DetachedChatApp({
  initialWindowContext,
}: DetachedChatAppProps): React.JSX.Element {
  const [windowContext, setWindowContext] = useState(() => {
    persistComposerDraft(
      initialWindowContext.conversationId,
      initialWindowContext.draft,
    );
    return initialWindowContext;
  });
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pinning, setPinning] = useState(false);
  const [cornerControlsWidth, setCornerControlsWidth] = useState(0);
  const nativeTitleRef = useRef<string | null>(null);
  const documentPresence = useDocumentPresence();
  const connection = useStableController(useInertiaConnection({ applyTodos: false }));
  const conversationId = windowContext.conversationId;
  const subscribe = connection.subscribe;
  useEffect(() => {
    const unsubscribe = subscribe((event) => {
      if (event.type === "conversation.message.focus" && event.target.conversationId === conversationId) {
        requestMessageSearchFocus(event.target);
      }
    });
    return () => { unsubscribe(); clearMessageSearchFocus(); };
  }, [subscribe, conversationId]);
  const settings = useMemo<AppSettings>(
    () => connection.snapshot?.settings ?? cachedAppSettings(),
    [connection.snapshot?.settings],
  );
  useTheme(settings);

  useEffect(() => {
    return onComposerDraftPersisted((persistence) => {
      if (persistence.conversationId === conversationId) {
        window.inertia.mirrorDetachedChatDraft(persistence.draft);
      }
    });
  }, [conversationId]);

  useEffect(() => {
    applyInterfaceScale(settings.interfaceScale);
  }, [settings.interfaceScale]);

  useEffect(() => {
    const persistBeforeNativeClose = (event: BeforeUnloadEvent): void => {
      preserveDetachedDraftBeforeUnload(
        event,
        prepareComposerDetachment(conversationId),
        (draft) => window.inertia.persistDetachedChatDraft(draft),
        setActionError,
      );
    };
    window.addEventListener("beforeunload", persistBeforeNativeClose, true);
    return () => window.removeEventListener(
      "beforeunload",
      persistBeforeNativeClose,
      true,
    );
  }, [conversationId]);

  const handoff = useDetachedHandoff(conversationId, setActionError);
  const workspace = useDetachedWorkspaceScene({
    conversationId,
    connection,
    settings,
    handoff,
    busyAction,
    setBusyAction,
    setActionError,
  });
  const { project, projection, layout, tools, scene, runtimeActions, request } = workspace;
  const conversation = projection.conversation;

  const projectedConversationId = conversation?.id ?? null;
  const conversationTitle = conversation?.title ?? null;
  useEffect(() => {
    const nativeTitle = detachedChatWindowTitle(conversationTitle ?? "");
    document.title = `${nativeTitle} — ${applicationProductName(window.location.protocol)}`;
    if (
      !projectedConversationId
      || nativeTitleRef.current === nativeTitle
    ) {
      return;
    }
    nativeTitleRef.current = nativeTitle;
    void window.inertia.retargetDetachedChat({
      conversationId,
      title: nativeTitle,
    }).catch(() => {
      nativeTitleRef.current = null;
    });
  }, [conversationId, conversationTitle, projectedConversationId]);

  const closeWindow = useCallback(() => {
    setActionError(null);
    const preparation = prepareComposerDetachment(conversationId);
    if (preparation.status === "blocked") {
      setActionError(preparation.reason);
      return;
    }
    void window.inertia.closeDetachedChat(preparation.draft).catch((error: unknown) => {
      setActionError(publicError(error, "This window could not be closed."));
    });
  }, [conversationId]);
  const projectId = project?.id ?? null;
  const openInMain = handoff.openInMain;
  useDetachedShortcuts({
    keybindings: settings.keybindings,
    toggleTerminal: layout.toggleTerminal,
    createConversation: () => {
      if (projectId) openInMain(newChatTarget(projectId));
    },
    openSettings: () => openInMain({ kind: "settings", page: "general" }),
    closeWindow,
  });
  const toggleAlwaysOnTop = useCallback(() => {
    if (pinning) return;
    setPinning(true);
    setActionError(null);
    void window.inertia
      .setDetachedChatAlwaysOnTop(!windowContext.alwaysOnTop)
      .then((next) => {
        setWindowContext((current) => ({
          ...current,
          alwaysOnTop: next.alwaysOnTop,
        }));
      })
      .catch((error: unknown) => {
        setActionError(publicError(error, "This window could not be pinned."));
      })
      .finally(() => setPinning(false));
  }, [pinning, windowContext.alwaysOnTop]);

  useMarkRunSeen({
    request,
    runs: connection.snapshot?.runs,
    conversationId,
    workspaceVisible: documentPresence > 0,
    latestContentVisible: workspace.latestContentVisible,
    obstructed: false,
    refresh: documentPresence,
  });

  const detailState = projection.detailState?.conversationId === conversationId
    ? projection.detailState
    : null;
  const unavailableDetail = detailState
    && detailState.state !== "loading"
    && detailState.state !== "ready"
      ? detailState
      : null;
  const contextRequests = useMemo(
    () => detachedContextRequests(projection.pendingInputs),
    [projection.pendingInputs],
  );
  const watchers = useWatcherSurfaceController({
    snapshot: connection.snapshot,
    surface: "detached",
    online: connection.status === "online",
    request: null,
    primaryConversationId: conversationId,
  });
  const duoVisibleConversationIds = useMemo(() => [conversationId], [conversationId]);
  const openDuoConversation = useCallback((targetId: string): void => {
    openInMain({ kind: "conversation", conversationId: targetId });
  }, [openInMain]);
  const duoLaunches = useDuoLaunchWatch({
    snapshot: connection.snapshot,
    request,
    startupSweep: connection.status === "online",
    visibleConversationIds: duoVisibleConversationIds,
    onStatusUpdate: ignoreDuoStatusUpdate,
    onError: setActionError,
    openConversation: openDuoConversation,
  });
  const openUsageLimits = useCallback(
    () => openInMain({ kind: "usage-limits" }),
    [openInMain],
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
  const platform = window.inertia?.getPlatform?.() ?? "unknown";
  const toolScene = conversation && project ? scene.tools : null;
  const panelOpen = Boolean(toolScene && layout.toolsVisible);
  const inlinePanel = panelOpen && layout.panelPresentation === "inline";
  const sheetPanel = panelOpen && layout.panelPresentation === "sheet";
  const frameStyle = {
    ...layout.workspaceBodyStyle,
    "--workspace-corner-controls-width": `${cornerControlsWidth}px`,
  } as CSSProperties;
  return (
    <DetachedUsageLimitsProvider request={request} status={connection.status} onOpen={openUsageLimits}>
    <WorkingIndicatorProvider settings={settings.workingIndicator}>
    <HtmlRenderRuntimeStatusContext.Provider value={connection.status}>
    <WatcherContext.Provider value={watchers.surface}>
    <DuoJudgeNoticeContext.Provider value={duoLaunches.notices}>
    <div
      ref={layout.appShellRef}
      className={`detached-chat-shell platform-${platform}`}
      data-interface-scale={settings.interfaceScale}
      style={{ "--mac-titlebar-brand-safe-inset": `${MAC_BRAND_SAFE_INSET}px` } as CSSProperties}
    >
      <div
        className={`workspace-frame has-corner-controls${inlinePanel ? " has-right-panel" : ""}${sheetPanel ? " has-right-sheet" : ""}`}
        style={frameStyle}
      >
        <DetachedChatHeader
          platform={platform}
          title={conversation?.title ?? "Detached chat"}
          project={project}
          conversation={projection.detail?.conversation ?? conversation}
          settings={settings}
          runs={connection.snapshot?.runs}
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
          alwaysOnTop={windowContext.alwaysOnTop}
          pinning={pinning}
          onToggleAlwaysOnTop={toggleAlwaysOnTop}
          onDock={handoff.dockInMain}
          onClose={closeWindow}
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
          {conversation && project && connection.snapshot ? (
            <WorkspaceScene {...visibleScene} />
          ) : unavailableDetail ? (
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
        </div>
      </div>

      {(actionError || connection.error) && (
        <div className="detached-chat-error" role="alert">
          <span>{actionError ?? connection.error}</span>
          <button type="button" onClick={() => {
            setActionError(null);
            connection.clearError();
          }}>Dismiss</button>
        </div>
      )}
    </div>
    </DuoJudgeNoticeContext.Provider>
    </WatcherContext.Provider>
    </HtmlRenderRuntimeStatusContext.Provider>
    </WorkingIndicatorProvider>
    </DetachedUsageLimitsProvider>
  );
}
