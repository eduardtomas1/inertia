import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AppSettings } from "@shared/contracts";
import type { DesktopWindowContext } from "@shared/desktop";
import { detachedChatWindowTitle } from "@shared/desktop-window-title";
import { MAC_BRAND_SAFE_INSET } from "@shared/window-chrome";
import { applicationProductName } from "../../shared/workspace-image-preview";

import { clearMessageSearchFocus, requestMessageSearchFocus } from "./utils/messageSearchFocus";
import "./detached-chat.css";
import { DetachedWorkspace } from "./components/detached/DetachedWorkspace";
import { newChatTarget } from "./components/detached/detachedTargets";
import { detachedTerminalIds, useDetachedHandoff } from "./components/detached/useDetachedHandoff";
import { useDetachedShortcuts } from "./components/detached/useDetachedShortcuts";
import { useDocumentPresence } from "./hooks/useDocumentPresence";
import { useInertiaConnection } from "./hooks/useInertiaConnection";
import { useStableController } from "./hooks/useStableController";
import { useTheme } from "./hooks/useTheme";
import { withRequestId, type CommandWithoutId } from "./lib/runtimeCommands";
import { onComposerDraftPersisted, persistComposerDraft, readComposerDraft } from "./utils/composerDraftPersistence";
import { onTerminalTabsChanged, terminalStorageKey } from "./components/terminalTabStorage";
import { prepareComposerDetachment } from "./utils/composerOwnership";
import { applyInterfaceScale } from "./utils/interfaceScale";
import { cachedAppSettings } from "./utils/cachedSettings";
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
  const nativeTitleRef = useRef<string | null>(null);
  const terminalToggleRef = useRef<(() => void) | null>(null);
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
  const sendCommand = connection.sendCommand;
  const request = useCallback(
    (command: CommandWithoutId) => sendCommand(withRequestId(command)),
    [sendCommand],
  );
  const settings = useMemo<AppSettings>(
    () => connection.snapshot?.settings ?? cachedAppSettings(),
    [connection.snapshot?.settings],
  );
  useTheme(settings);

  useEffect(() => {
    applyInterfaceScale(settings.interfaceScale);
  }, [settings.interfaceScale]);

  const snapshotConversation = connection.snapshot?.conversations.find(
    ({ id }) => id === conversationId,
  ) ?? null;
  const projectId = snapshotConversation?.projectId ?? null;

  useEffect(() => {
    const mirror = (draft: string): void => {
      window.inertia.mirrorDetachedChatDraft(draft, detachedTerminalIds(projectId, conversationId));
    };
    const stopDrafts = onComposerDraftPersisted((persistence) => {
      if (persistence.conversationId === conversationId) mirror(persistence.draft);
    });
    const stopTerminals = onTerminalTabsChanged((storageKey) => {
      if (projectId && storageKey === terminalStorageKey(projectId, conversationId)) {
        mirror(readComposerDraft(conversationId));
      }
    });
    return () => {
      stopDrafts();
      stopTerminals();
    };
  }, [conversationId, projectId]);

  useEffect(() => {
    const persistBeforeNativeClose = (event: BeforeUnloadEvent): void => {
      preserveDetachedDraftBeforeUnload(
        event,
        prepareComposerDetachment(conversationId),
        (draft) => window.inertia.persistDetachedChatDraft(
          draft,
          detachedTerminalIds(projectId, conversationId),
        ),
        setActionError,
      );
    };
    window.addEventListener("beforeunload", persistBeforeNativeClose, true);
    return () => window.removeEventListener(
      "beforeunload",
      persistBeforeNativeClose,
      true,
    );
  }, [conversationId, projectId]);
  const conversationTitle = snapshotConversation?.title ?? null;
  useEffect(() => {
    const nativeTitle = detachedChatWindowTitle(conversationTitle ?? "");
    document.title = `${nativeTitle} — ${applicationProductName(window.location.protocol)}`;
    if (
      conversationTitle === null
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
  }, [conversationId, conversationTitle]);

  const handoff = useDetachedHandoff(conversationId, projectId, setActionError);
  const closeWindow = useCallback(() => {
    setActionError(null);
    const preparation = prepareComposerDetachment(conversationId);
    if (preparation.status === "blocked") {
      setActionError(preparation.reason);
      return;
    }
    void window.inertia.closeDetachedChat(
      preparation.draft,
      detachedTerminalIds(projectId, conversationId),
    ).catch((error: unknown) => {
      setActionError(publicError(error, "This window could not be closed."));
    });
  }, [conversationId, projectId]);
  const openInMain = handoff.openInMain;
  useDetachedShortcuts({
    keybindings: settings.keybindings,
    toggleTerminal: () => terminalToggleRef.current?.(),
    createConversation: () => {
      if (projectId) openInMain(newChatTarget(projectId));
    },
    openSettings: () => openInMain({ kind: "settings", page: "appearance" }),
    closeWindow,
  });
  const setTerminalToggle = useCallback((toggle: (() => void) | null) => {
    terminalToggleRef.current = toggle;
  }, []);
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
  const windowActions = useMemo(() => ({
    alwaysOnTop: windowContext.alwaysOnTop,
    pinning,
    onToggleAlwaysOnTop: toggleAlwaysOnTop,
    onDock: handoff.dockInMain,
    onClose: closeWindow,
  }), [closeWindow, handoff.dockInMain, pinning, toggleAlwaysOnTop, windowContext.alwaysOnTop]);

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
  const platform = window.inertia?.getPlatform?.() ?? "unknown";
  return (
    <WorkingIndicatorProvider settings={settings.workingIndicator}>
    <HtmlRenderRuntimeStatusContext.Provider value={connection.status}>
    <WatcherContext.Provider value={watchers.surface}>
    <DuoJudgeNoticeContext.Provider value={duoLaunches.notices}>
    <div
      className={`detached-chat-shell platform-${platform}`}
      data-interface-scale={settings.interfaceScale}
      style={{ "--mac-titlebar-brand-safe-inset": `${MAC_BRAND_SAFE_INSET}px` } as CSSProperties}
    >
      <DetachedWorkspace
        conversationId={conversationId}
        terminalHandoffIds={windowContext.terminalIds}
        connection={connection}
        settings={settings}
        handoff={handoff}
        platform={platform}
        documentPresence={documentPresence}
        busyAction={busyAction}
        setBusyAction={setBusyAction}
        setActionError={setActionError}
        windowActions={windowActions}
        onTerminalToggleChange={setTerminalToggle}
      />

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
  );
}
