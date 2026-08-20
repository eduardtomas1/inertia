import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  MessagesSquare,
  PanelTopOpen,
  Pin,
  PinOff,
  Radio,
  X,
} from "lucide-react";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentInputRequest,
  AppSettings,
  CheckpointSummary,
  ProviderId,
  SubagentTrace,
} from "@shared/contracts";
import { defaultSettings } from "@shared/contracts/app";
import type { DesktopWindowContext } from "@shared/desktop";
import { selectConversationWorkspaceRun } from "../../shared/attention";

import { ChatWorkspace } from "./components/ChatWorkspace";
import "./detached-chat.css";
import { ConversationDetailState } from "./components/ConversationDetailState";
import { IconButton, LoadingMark } from "./components/ui";
import {
  withRequestId,
  type CommandWithoutId,
} from "./lib/runtimeCommands";
import {
  agentWorkflowRouteIdentity,
  useAgentWorkflows,
} from "./hooks/useAgentWorkflows";
import { useAppRuntimeActions } from "./hooks/useAppRuntimeActions";
import { useBackendProfiles } from "./hooks/useBackendProfiles";
import { useConversationProjection } from "./hooks/useConversationProjection";
import { useDesktopTools } from "./hooks/useDesktopTools";
import { useDocumentPresence } from "./hooks/useDocumentPresence";
import { useInertiaConnection } from "./hooks/useInertiaConnection";
import { useStableController } from "./hooks/useStableController";
import { useTheme } from "./hooks/useTheme";
import { useWorkspaceMentions } from "./hooks/workspace-tools/useWorkspaceMentions";
import {
  canFollowUpSubagentTrace,
  canStopSubagentTrace,
} from "./utils/subagentDisclosure";
import { requestComposerPrefill } from "./utils/composerPrefill";
import { onComposerDraftPersisted } from "./utils/composerDraftPersistence";
import { prepareComposerDetachment } from "./utils/composerOwnership";
import {
  goalControlsBusy,
  goalExecutionStatus,
} from "./utils/goalExecution";
import { applyInterfaceScale } from "./utils/interfaceScale";
import {
  cachedColorTheme,
  cachedThemePreference,
} from "./utils/theme";
import { shouldMarkWorkspaceRunSeen } from "./utils/attentionVisibility";

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
      <MessagesSquare size={15} aria-hidden="true" />
      <span>
        <strong>Agent requested chat context</strong>
        <small>Review this request in the main window.</small>
      </span>
      <button type="button" onClick={onReturnToMain}>
        <PanelTopOpen size={13} aria-hidden="true" />
        Return to main
      </button>
    </div>
  );
}

export default function DetachedChatApp({
  initialWindowContext,
}: DetachedChatAppProps): React.JSX.Element {
  const [windowContext, setWindowContext] = useState(() => {
    try {
      const key = `inertia:draft:${initialWindowContext.conversationId}`;
      if (initialWindowContext.draft) {
        window.localStorage.setItem(key, initialWindowContext.draft);
      } else {
        window.localStorage.removeItem(key);
      }
    } catch {
      // The privileged draft handoff still protects explicit close and dock.
    }
    return initialWindowContext;
  });
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [latestContentVisible, setLatestContentVisible] = useState(false);
  const [pinning, setPinning] = useState(false);
  const pendingSeenRunsRef = useRef(new Set<string>());
  const nativeTitleRef = useRef<string | null>(null);
  const documentPresence = useDocumentPresence();
  const connection = useStableController(useInertiaConnection());
  const conversationId = windowContext.conversationId;
  const sendCommand = connection.sendCommand;
  const request = useCallback(
    (command: CommandWithoutId) => sendCommand(withRequestId(command)),
    [sendCommand],
  );
  const settings = useMemo<AppSettings>(
    () => connection.snapshot?.settings ?? {
      ...defaultSettings,
      theme: cachedThemePreference(window.localStorage)
        ?? defaultSettings.theme,
      colorTheme: cachedColorTheme(window.localStorage)
        ?? defaultSettings.colorTheme,
    },
    [connection.snapshot?.settings],
  );
  useTheme(settings.theme, settings.colorTheme);

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

  const projection = useStableController(useConversationProjection({
    snapshot: connection.snapshot,
    status: connection.status,
    request,
    subscribe: connection.subscribe,
    targetConversationId: conversationId,
    enabled: true,
    autoOpenPlan: false,
    onOpenPlan: () => undefined,
    onTerminal: () => undefined,
  }));
  const conversation = projection.conversation;
  const project = useMemo(
    () => connection.snapshot?.projects.find(
      ({ id }) => id === conversation?.projectId,
    ) ?? null,
    [connection.snapshot?.projects, conversation?.projectId],
  );
  const workflow = useStableController(useAgentWorkflows({
    conversationId: conversation?.id ?? null,
    routeIdentity: agentWorkflowRouteIdentity(conversation, project),
    status: connection.status,
    enabled: Boolean(conversation),
    request,
    subscribe: connection.subscribe,
  }));
  const runtimeActions = useStableController(useAppRuntimeActions({
    sendCommand,
    refreshDetail: projection.refreshDetail,
    setBusyAction,
    setActionError,
  }));
  const backendProfiles = useStableController(useBackendProfiles({
    request,
    run: runtimeActions.run,
  }));
  const desktopTools = useStableController(useDesktopTools({
    setActionError,
    previewContextId: null,
  }));
  const mentions = useStableController(useWorkspaceMentions({
    enabled: Boolean(project && conversation),
    project,
    conversation,
    request,
  }));

  const projectedConversationId = conversation?.id ?? null;
  const conversationTitle = conversation?.title ?? null;
  useEffect(() => {
    const chatTitle = conversationTitle ?? "Detached chat";
    document.title = `${chatTitle} — Inertia`;
    const nativeTitle = chatTitle.trim();
    if (
      !projectedConversationId
      || !nativeTitle
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

  const dockInMain = useCallback(() => {
    setActionError(null);
    const preparation = prepareComposerDetachment(conversationId);
    if (preparation.status === "blocked") {
      setActionError(preparation.reason);
      return;
    }
    void window.inertia.dockDetachedChat(preparation.draft).catch((error: unknown) => {
      setActionError(publicError(
        error,
        "This chat could not be returned to the main window.",
      ));
    });
  }, [conversationId]);
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

  const respondToApproval = useCallback(async (
    approval: AgentApprovalRequest,
    decision: AgentApprovalDecision,
  ): Promise<void> => {
    await runtimeActions.run("agent.approval.respond", {
      type: "agent.approval.respond",
      payload: {
        conversationId: approval.conversationId,
        requestId: approval.id,
        decision,
      },
    });
  }, [runtimeActions]);
  const respondToInput = useCallback(async (
    input: AgentInputRequest,
    answers: Record<string, string[]>,
  ): Promise<void> => {
    await runtimeActions.run("agent.input.respond", {
      type: "agent.input.respond",
      payload: {
        conversationId: input.conversationId,
        requestId: input.id,
        answers,
      },
    });
  }, [runtimeActions]);
  const updateConversation = useCallback(async (
    update: Parameters<
      typeof runtimeActions.updateConversationById
    >[1],
  ): Promise<void> => {
    await runtimeActions.updateConversationById(conversationId, update);
  }, [conversationId, runtimeActions]);
  const updateSettings = useCallback(async (
    update: Partial<AppSettings>,
  ): Promise<void> => {
    await runtimeActions.run("settings.update", {
      type: "settings.update",
      payload: update,
    });
  }, [runtimeActions]);
  const refreshProvider = useCallback((providerId: ProviderId): void => {
    void runtimeActions.run("provider.refresh", {
      type: "provider.refresh",
      payload: { providerId },
    }).catch(() => undefined);
  }, [runtimeActions]);
  const stopAgent = useCallback(async (): Promise<void> => {
    await runtimeActions.run("agent.stop", {
      type: "agent.stop",
      payload: { conversationId },
    });
  }, [conversationId, runtimeActions]);
  const stopSubagent = useCallback(async (
    trace: SubagentTrace,
  ): Promise<void> => {
    await runtimeActions.run(`agent.subagent.stop:${trace.id}`, {
      type: "agent.subagent.stop",
      payload: {
        conversationId: trace.conversationId,
        traceId: trace.id,
      },
    });
  }, [runtimeActions]);
  const revertCheckpoint = useCallback((checkpoint: CheckpointSummary): void => {
    const confirmed = !settings.confirmDestructiveActions
      || window.confirm(
        "Restore the project to before this turn? "
        + "Untracked files created later will be left in place.",
      );
    if (!confirmed) return;
    void runtimeActions.run("checkpoint.revert", {
      type: "checkpoint.revert",
      payload: {
        conversationId,
        checkpointId: checkpoint.id,
      },
    }).catch(() => undefined);
  }, [conversationId, runtimeActions, settings.confirmDestructiveActions]);
  const followUpSubagent = useCallback((trace: SubagentTrace): void => {
    if (!conversation || !canFollowUpSubagentTrace(trace, projection.turns)) {
      return;
    }
    const task = trace.description ?? trace.providerRole ?? "delegated task";
    requestComposerPrefill({
      conversationId,
      text: `Please follow up on the delegated task “${task}” and incorporate its latest result.`,
    });
  }, [conversation, conversationId, projection.turns]);
  const openProjectFile = useCallback((path: string): void => {
    if (!project) return;
    void window.inertia.openProjectPath({
      projectId: project.id,
      conversationId,
      relativePath: path,
      action: "open-externally",
    }).catch((error: unknown) => {
      setActionError(publicError(error, "The project file could not be opened."));
    });
  }, [conversationId, project]);

  const visibleRun = useMemo(
    () => selectConversationWorkspaceRun(
      conversationId,
      connection.snapshot?.runs ?? [],
    ),
    [connection.snapshot?.runs, conversationId],
  );
  useEffect(() => {
    if (
      !visibleRun
      || pendingSeenRunsRef.current.has(visibleRun.id)
      || !shouldMarkWorkspaceRunSeen(visibleRun, conversationId, {
        documentVisible: document.visibilityState === "visible",
        documentFocused: document.hasFocus(),
        workspaceVisible: documentPresence > 0,
        latestContentVisible,
        obstructed: false,
      })
    ) return;
    pendingSeenRunsRef.current.add(visibleRun.id);
    void request({
      type: "activity.mark-seen",
      payload: { runId: visibleRun.id },
    }).catch(() => undefined).finally(() => {
      pendingSeenRunsRef.current.delete(visibleRun.id);
    });
  }, [
    conversationId,
    documentPresence,
    latestContentVisible,
    request,
    visibleRun,
  ]);

  const workflowState = workflow.state?.conversationId === conversationId
    ? workflow.state
    : null;
  const conversationRunning = conversation?.status === "running"
    || conversation?.status === "needs-input";
  const workflowSafetyLocked = workflow.error
    ?.includes("recovery safety mode") === true;
  const executionStatus = workflowSafetyLocked
    ? "idle"
    : conversationRunning
      ? goalExecutionStatus(projection.turns)
      : "idle";
  const goalBusy = goalControlsBusy({
    connectionStatus: connection.status,
    workflowLoading: workflow.loading,
    safetyLocked: workflowSafetyLocked,
    executionStatus,
    busyAction,
  }) || workflow.mutating;
  const detailState = projection.detailState?.conversationId === conversationId
    ? projection.detailState
    : null;
  const unavailableDetail = detailState
    && detailState.state !== "loading"
    && detailState.state !== "ready"
      ? detailState
      : null;
  const detailLoading = Boolean(
    conversation
    && (!detailState || detailState.state === "loading"),
  );
  const contextHandoffPending = projection.pendingInputs.some(
    ({ conversationContextRequest }) => conversationContextRequest !== undefined,
  );
  const visibleConversation = projection.detail?.conversation ?? conversation;
  const statusLabel = connection.status === "online"
    ? conversation?.status === "running"
      ? "Working"
      : conversation?.status === "needs-input"
        ? "Needs input"
        : "Live"
    : connection.status === "connecting"
      ? "Connecting"
      : "Offline";

  return (
    <div
      className="detached-chat-shell"
      data-connection-status={connection.status}
      data-interface-scale={settings.interfaceScale}
    >
      <header className="detached-chat-header drag-region">
        <div className="detached-chat-title">
          <span>{project?.name ?? "Inertia"}</span>
          <h1>{conversation?.title ?? "Detached chat"}</h1>
        </div>
        <div className="detached-chat-window-actions no-drag">
          <span className="detached-chat-status" role="status">
            <Radio size={11} aria-hidden="true" />
            {statusLabel}
          </span>
          <IconButton
            label={windowContext.alwaysOnTop
              ? "Unpin chat window"
              : "Keep chat window on top"}
            aria-pressed={windowContext.alwaysOnTop}
            disabled={pinning}
            onClick={toggleAlwaysOnTop}
          >
            {windowContext.alwaysOnTop
              ? <PinOff size={15} />
              : <Pin size={15} />}
          </IconButton>
          <IconButton label="Return chat to main window" onClick={dockInMain}>
            <PanelTopOpen size={16} />
          </IconButton>
          <IconButton label="Close chat window" onClick={closeWindow}>
            <X size={16} />
          </IconButton>
        </div>
      </header>

      <div className="detached-chat-content">
        {contextHandoffPending && (
          <DetachedContextHandoffNotice onReturnToMain={dockInMain} />
        )}
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
        ) : !conversation || !project ? (
          <ConversationDetailState
            embedded
            state="missing"
            onRetry={projection.refreshDetail}
          />
        ) : (
          <ChatWorkspace
            embedded
            project={project}
            conversation={visibleConversation}
            showCheckoutContext={false}
            latestTurnSummary={projection.latestTurnSummary}
            turns={projection.turns}
            messages={projection.messages}
            activities={projection.activities}
            subagents={projection.subagents}
            reasonings={projection.reasonings}
            plans={projection.plans}
            checkpoints={projection.checkpoints}
            turnGitArtifacts={projection.turnGitArtifacts}
            streamingText={projection.streamingText}
            streamingReasoning={projection.streamingReasoning}
            streamingChannel={projection.streamingChannel}
            terminalProjections={projection.terminalProjections}
            usage={projection.usage}
            skills={workflowState?.skills ?? []}
            skillsCapability={workflowState?.skillsCapability ?? null}
            skillsLoading={workflow.loading}
            skillsError={workflow.error}
            promptPresetsEnabled={false}
            promptStashEnabled={false}
            conversationContextHandoffEnabled={false}
            goal={{
              workflow: workflowState,
              executionStatus,
              loading: workflow.loading,
              busy: goalBusy,
              error: workflow.error,
              onRetry: () => workflow.refresh(true),
              onSetGoal: workflow.setGoal,
              onClearGoal: workflow.clearGoal,
            }}
            approvals={projection.pendingApprovals}
            inputRequests={projection.pendingInputs}
            providers={connection.snapshot.providers}
            backendProfiles={connection.snapshot.backendProfiles ?? []}
            maintenanceStatus={null}
            maintenanceOperation={null}
            actions={[]}
            mentionResults={mentions.mentionResults}
            showTimestamps={settings.showTimestamps}
            showThinking={settings.showThinking}
            usageDisplayMode={settings.usageDisplayMode}
            responseDensity={settings.responseDensity}
            defaultCodeWrap={settings.defaultCodeWrap}
            autoCollapseWorkLog={settings.autoCollapseWorkLog}
            showChangedFileSummaries={settings.showChangedFileSummaries}
            autoScrollToFinalAnswer={settings.autoScrollToFinalAnswer}
            promptContext={null}
            contextPackets={projection.detail?.contextPackets ?? []}
            previewContextUrl={null}
            providerIdentityLabels={settings.providerIdentityLabels}
            loading={false}
            detailLoading={detailLoading}
            sending={runtimeActions.sendingConversationIds.has(conversationId)}
            onAddProject={dockInMain}
            onCreateConversation={dockInMain}
            onSendMessage={(content, attachments, context) =>
              runtimeActions.sendMessageToConversation(
                conversationId,
                content,
                attachments,
                context,
                false,
              )}
            onCompactConversation={(instruction) =>
              runtimeActions.compactConversation(conversationId, instruction)}
            onListSkills={workflow.listSkills}
            onRespondToApproval={respondToApproval}
            onRespondToInput={respondToInput}
            onUpdateConversation={updateConversation}
            onChooseAttachments={desktopTools.chooseComposerAttachments}
            onImportAttachments={desktopTools.importComposerAttachments}
            onReleaseAttachment={desktopTools.releaseComposerAttachment}
            onRunAction={dockInMain}
            onMentionQuery={mentions.searchMentions}
            onConnectProvider={dockInMain}
            onRefreshProvider={refreshProvider}
            onOpenProviderSetup={dockInMain}
            onOpenBackendSetup={dockInMain}
            onProbeBackendProfile={async (profileId, modelId) => {
              await backendProfiles.probeBackendProfile(profileId, modelId);
            }}
            onRefreshProviderMaintenance={() => Promise.resolve()}
            onUpdateProvider={() => Promise.resolve()}
            onCancelProviderUpdate={() => Promise.resolve()}
            onOpenProviderUpdateInstructions={(url) => {
              void window.inertia.openExternal(url).catch(() => undefined);
            }}
            onOpenResume={dockInMain}
            resumeOptions={[]}
            onResumeConversation={dockInMain}
            onUsageDisplayModeChange={(mode) => {
              void updateSettings({ usageDisplayMode: mode })
                .catch(() => undefined);
            }}
            onStop={stopAgent}
            onFollowUpSubagent={followUpSubagent}
            onStopSubagent={async (trace) => {
              if (canStopSubagentTrace(trace, projection.turns)) {
                await stopSubagent(trace);
              }
            }}
            onRevertCheckpoint={revertCheckpoint}
            onOpenTurnDiff={dockInMain}
            onCompareTurnArtifacts={dockInMain}
            onOpenTurnFile={openProjectFile}
            onLatestContentVisibilityChange={setLatestContentVisible}
          />
        )}
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
  );
}
