import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type {
  ChatAttachment,
  ModelSelection,
} from "@shared/contracts";
import { MAX_CHAT_ATTACHMENTS } from "@shared/contracts";
import {
  isKimiThroughClaudeSelection,
  KIMI_CLAUDE_REASONING_OPTIONS,
  kimiCodingModelDisplayName,
  modelSelectionIdentityLabel,
} from "../../../../shared/claude-backend-profiles";
import { MAX_CHAT_MESSAGE_CHARS } from "../../../../shared/diff-review";
import {
  legacyProviderIdForHarness,
} from "../../../../shared/model-routing";
import { composerRouteReadiness } from "../../utils/composerReadiness";
import {
  buildComposerModelRoutes,
  selectedModelSearchRoute,
  type ComposerModelRoute,
} from "../../utils/modelChooserRoutes";
import { resolveModelRouteTransition } from "../../utils/modelRouteTransition";
import { buildComposerTurnRequest } from "../../utils/requestContext";
import {
  documentAttachmentSendBoundary,
  mergeComposerAttachments,
} from "../../utils/composerAttachments";
import {
  COMPOSER_ACTION_STALE_FALLBACK_MS,
  composerFollowUpState,
  composerPrimaryActionState,
} from "../../utils/composerPrimaryAction";
import {
  composerHarnessLabel,
} from "./config";
import {
  addPromptStashEntry,
  PROMPT_STASH_CHANGED_EVENT,
  PROMPT_STASH_STORAGE_KEY,
  promptStashRouteMatches,
  readPromptStash,
  removePromptStashEntry,
  writePromptStash,
  type PromptStashEntry,
} from "../../utils/promptStash";
import { ComposerInputZone } from "./ComposerInputZone";
import { ComposerToolbar } from "./ComposerToolbar";
import type { ComposerProps } from "./types";
import { useComposerMenus } from "./useComposerMenus";
import { useTextareaAutosize } from "./useTextareaAutosize";

export function Composer({
  conversation,
  providers,
  actions,
  disabled,
  sending,
  running,
  backendProfiles = [],
  latestTurn = null,
  mentionResults,
  usage,
  usageDisplayMode,
  promptContext,
  onSend,
  onUpdateConversation,
  onCreateConversationForSelection,
  onChooseAttachments,
  onImportAttachments,
  onReleaseAttachment,
  onRunAction,
  onMentionQuery,
  onConnectProvider,
  onRefreshProvider,
  onOpenProviderSetup,
  onOpenBackendSetup,
  onProbeBackendProfile,
  onUsageDisplayModeChange,
  onStop,
  onClearPromptContext,
}: ComposerProps): React.JSX.Element {
  const [message, setMessage] = useState(
    () => window.localStorage.getItem(`inertia:draft:${conversation.id}`) ?? "",
  );
  const [promptStash, setPromptStash] = useState(
    () => readPromptStash(window.localStorage),
  );
  const skipDraftPersistenceRef = useRef(true);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const attachmentsRef = useRef<ChatAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const submissionReleaseTimerRef = useRef<number | null>(null);
  const [stopping, setStopping] = useState(false);
  const stoppingRef = useRef(false);
  const stopReleaseTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const conversationIdRef = useRef(conversation.id);
  const releaseAttachmentRef = useRef(onReleaseAttachment);
  const [fileReferences, setFileReferences] = useState<string[]>([]);
  const [pendingRoute, setPendingRoute] = useState<{
    selection: ModelSelection;
    label: string;
    reason: string;
  } | null>(null);
  const [creatingRouteConversation, setCreatingRouteConversation] = useState(false);
  const [routeRepairing, setRouteRepairing] = useState(false);
  const menuController = useComposerMenus();
  const { menu, dismissMenu } = menuController;
  const composerRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const routeCancelRef = useRef<HTMLButtonElement>(null);
  const mentionMatch = /(?:^|\s)@([^\s@]{1,200})$/u.exec(message);
  const slashMatch = /^\/(\w*)$/u.exec(message.trim());

  conversationIdRef.current = conversation.id;

  useEffect(() => {
    const refreshPromptStash = (): void => {
      setPromptStash(readPromptStash(window.localStorage));
    };
    const refreshFromStorage = (event: StorageEvent): void => {
      if (event.key === PROMPT_STASH_STORAGE_KEY) refreshPromptStash();
    };
    window.addEventListener(PROMPT_STASH_CHANGED_EVENT, refreshPromptStash);
    window.addEventListener("storage", refreshFromStorage);
    return () => {
      window.removeEventListener(
        PROMPT_STASH_CHANGED_EVENT,
        refreshPromptStash,
      );
      window.removeEventListener("storage", refreshFromStorage);
    };
  }, []);
  releaseAttachmentRef.current = onReleaseAttachment;

  useEffect(() => {
    skipDraftPersistenceRef.current = true;
    if (submissionReleaseTimerRef.current !== null) {
      window.clearTimeout(submissionReleaseTimerRef.current);
      submissionReleaseTimerRef.current = null;
    }
    if (stopReleaseTimerRef.current !== null) {
      window.clearTimeout(stopReleaseTimerRef.current);
      stopReleaseTimerRef.current = null;
    }
    submittingRef.current = false;
    stoppingRef.current = false;
    setSubmitting(false);
    setStopping(false);
    setMessage(window.localStorage.getItem(`inertia:draft:${conversation.id}`) ?? "");
    for (const attachment of attachmentsRef.current) {
      void onReleaseAttachment(attachment.id);
    }
    attachmentsRef.current = [];
    setAttachments([]);
    setFileReferences([]);
    setPendingRoute(null);
    setCreatingRouteConversation(false);
    setRouteRepairing(false);
    dismissMenu("context-change");
  }, [conversation.id, dismissMenu, onReleaseAttachment]);

  useEffect(() => {
    if (running) {
      dismissMenu("context-change");
      if (submissionReleaseTimerRef.current !== null) {
        window.clearTimeout(submissionReleaseTimerRef.current);
        submissionReleaseTimerRef.current = null;
      }
      submittingRef.current = false;
      setSubmitting(false);
      return;
    }
    if (stopReleaseTimerRef.current !== null) {
      window.clearTimeout(stopReleaseTimerRef.current);
      stopReleaseTimerRef.current = null;
    }
    stoppingRef.current = false;
    setStopping(false);
  }, [dismissMenu, running]);

  useEffect(() => {
    if (!pendingRoute) return;
    window.requestAnimationFrame(() => routeCancelRef.current?.focus());
  }, [pendingRoute]);

  useEffect(() => () => {
    if (submissionReleaseTimerRef.current !== null) window.clearTimeout(submissionReleaseTimerRef.current);
    if (stopReleaseTimerRef.current !== null) window.clearTimeout(stopReleaseTimerRef.current);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const unsent = attachmentsRef.current;
      attachmentsRef.current = [];
      for (const attachment of unsent) {
        void releaseAttachmentRef.current(attachment.id);
      }
    };
  }, []);

  useEffect(() => {
    if (skipDraftPersistenceRef.current) {
      skipDraftPersistenceRef.current = false;
      return;
    }
    const key = `inertia:draft:${conversation.id}`;
    if (message) window.localStorage.setItem(key, message);
    else window.localStorage.removeItem(key);
  }, [conversation.id, message]);

  const mentionQuery = mentionMatch?.[1] ?? null;
  useEffect(() => {
    if (mentionQuery) onMentionQuery(mentionQuery);
  }, [mentionQuery, onMentionQuery]);

  useTextareaAutosize(textareaRef, message);

  const submit = async () => {
    const request = running
      ? {
          visibleContent: message.trim(),
          context: undefined,
        }
      : buildComposerTurnRequest(
          message,
          attachments,
          promptContext,
          fileReferences,
        );
    if (
      (!canSend && followUpState !== "ready")
      || submittingRef.current
    ) return;
    const submittedAttachments = [...attachmentsRef.current];
    const submittedConversationId = conversation.id;
    // Submitted files must remain registered while the provider reads them.
    // Removing them from the unsent ref prevents an unmount from releasing
    // their temporary copies after the server has accepted the turn.
    attachmentsRef.current = [];
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onSend(request.visibleContent, submittedAttachments, request.context);
      if (!mountedRef.current || conversationIdRef.current !== submittedConversationId) return;
      setMessage("");
      setAttachments([]);
      setFileReferences([]);
      onClearPromptContext?.();
      textareaRef.current?.focus();
      submissionReleaseTimerRef.current = window.setTimeout(() => {
        submissionReleaseTimerRef.current = null;
        submittingRef.current = false;
        if (mountedRef.current && conversationIdRef.current === submittedConversationId) {
          setSubmitting(false);
        }
      }, COMPOSER_ACTION_STALE_FALLBACK_MS);
    } catch {
      if (mountedRef.current && conversationIdRef.current === submittedConversationId) {
        attachmentsRef.current = submittedAttachments;
      } else {
        for (const attachment of submittedAttachments) {
          void onReleaseAttachment(attachment.id);
        }
      }
      // The workspace-level toast presents the failure; the current composer
      // keeps failed attachments available for retry when it is still mounted.
      submittingRef.current = false;
      if (mountedRef.current && conversationIdRef.current === submittedConversationId) {
        setSubmitting(false);
        textareaRef.current?.focus();
      }
    }
  };

  const stop = async (): Promise<void> => {
    if (stoppingRef.current || !running) return;
    const stoppedConversationId = conversation.id;
    stoppingRef.current = true;
    setStopping(true);
    try {
      await onStop();
      stopReleaseTimerRef.current = window.setTimeout(() => {
        stopReleaseTimerRef.current = null;
        stoppingRef.current = false;
        if (mountedRef.current && conversationIdRef.current === stoppedConversationId) {
          setStopping(false);
        }
      }, COMPOSER_ACTION_STALE_FALLBACK_MS);
    } catch {
      stoppingRef.current = false;
      if (mountedRef.current && conversationIdRef.current === stoppedConversationId) {
        setStopping(false);
      }
    }
  };

  const addAttachments = (incoming: readonly ChatAttachment[]): void => {
    const merged = mergeComposerAttachments(attachmentsRef.current, incoming);
    attachmentsRef.current = merged.attachments;
    setAttachments(merged.attachments);
    for (const attachment of merged.rejected) {
      void onReleaseAttachment(attachment.id);
    }
  };

  const removeAttachment = (attachment: ChatAttachment): void => {
    const next = attachmentsRef.current.filter(({ id }) => id !== attachment.id);
    attachmentsRef.current = next;
    setAttachments(next);
    void onReleaseAttachment(attachment.id);
  };

  const chooseAttachments = async () => {
    if (submittingRef.current || disabled || sending || running) return;
    const selected = await onChooseAttachments();
    addAttachments(selected);
  };

  const importAttachments = async (files: File[]) => {
    if (submittingRef.current || disabled || sending || running) return;
    const remaining = Math.max(0, MAX_CHAT_ATTACHMENTS - attachmentsRef.current.length);
    const candidates = files.slice(0, remaining);
    if (candidates.length === 0) return;
    const selected = await onImportAttachments(candidates);
    addAttachments(selected);
  };

  const selectedProvider = providers.find((provider) => provider.id === conversation.providerId);
  const selectedBackendProfile = backendProfiles.find(
    ({ id }) => id === conversation.modelSelection.backendProfileId,
  );
  const selectedBackendModel = selectedBackendProfile?.models.find(
    ({ id }) => id === conversation.modelSelection.modelId,
  );
  const kimiSelection = isKimiThroughClaudeSelection(conversation.modelSelection);
  const selectedModel = selectedBackendModel
    ? {
        id: selectedBackendModel.id,
        label: selectedBackendModel.displayName,
        description: `${selectedBackendProfile?.displayName ?? "Backend"} model through ${selectedBackendProfile?.harnessId ?? "the selected harness"}`,
        isDefault: selectedBackendProfile?.routing.primaryModelId === selectedBackendModel.id,
        inputModalities: ["text"] as const,
        reasoningOptions: selectedBackendModel.reasoningOptions,
        defaultReasoningEffort: selectedBackendModel.reasoningOptions.find(({ value }) =>
          value === conversation.modelSelection.reasoningEffort)?.value
          ?? selectedBackendModel.reasoningOptions[0]?.value
          ?? "",
      }
    : kimiSelection
    ? {
        id: conversation.modelSelection.modelId,
        label: kimiCodingModelDisplayName(conversation.modelSelection.modelId),
        description: "Kimi coding model through the Claude harness",
        isDefault: true,
        inputModalities: ["text"] as const,
        reasoningOptions: KIMI_CLAUDE_REASONING_OPTIONS,
        defaultReasoningEffort: "high",
      }
    : selectedProvider?.models.find(({ id }) => id === conversation.model)
      ?? selectedProvider?.models.find(({ isDefault }) => isDefault)
      ?? selectedProvider?.models[0];
  const selectedReasoning = conversation.reasoningEffort || selectedModel?.defaultReasoningEffort || "";
  const routeReadiness = composerRouteReadiness({
    provider: selectedProvider,
    profile: selectedBackendProfile,
    selection: conversation.modelSelection,
  });
  const selectedIdentityLabel = selectedBackendProfile
    ? `${composerHarnessLabel(selectedBackendProfile.harnessId)} · ${selectedBackendProfile.displayName} · ${selectedBackendModel?.displayName ?? conversation.modelSelection.modelId}`
    : kimiSelection
    ? modelSelectionIdentityLabel(conversation.modelSelection)
    : selectedProvider?.label ?? conversation.providerId;
  const composedLength = (message.trim() || (attachments.length > 0 ? "Please inspect the attached file." : "Please review the selected diff context.")).length;
  const typedMessageLimit = MAX_CHAT_MESSAGE_CHARS;
  const messageFits = composedLength <= MAX_CHAT_MESSAGE_CHARS;
  const attachmentSendBoundary = documentAttachmentSendBoundary(attachments);
  const sendEligible = (Boolean(message.trim()) || attachments.length > 0 || Boolean(promptContext))
    && messageFits
    && attachmentSendBoundary === null
    && routeReadiness.ready
    && !disabled;
  const primaryAction = composerPrimaryActionState({
    sendEligible,
    submitting,
    sending,
    running,
    stopping,
  });
  const canSend = primaryAction === "send-ready";
  const followUpState = composerFollowUpState({
    running,
    harnessId: latestTurn?.harnessId ?? null,
    hasDraft: Boolean(message.trim()),
    textOnly:
      attachments.length === 0
      && !promptContext
      && fileReferences.length === 0
      && messageFits
      && !disabled,
    submitting,
    sending,
  });
  const runRouteRepair = async (): Promise<void> => {
    if (routeReadiness.ready || !routeReadiness.action || routeRepairing) return;
    const action = routeReadiness.action;
    if (action === "install") {
      onOpenProviderSetup(conversation.providerId);
      return;
    }
    if (action === "connect") {
      onConnectProvider(conversation.providerId);
      return;
    }
    if (action === "add-key") {
      if (selectedBackendProfile) onOpenBackendSetup(selectedBackendProfile.id);
      return;
    }
    if (action === "probe" && !selectedBackendProfile?.enabled) {
      if (selectedBackendProfile) onOpenBackendSetup(selectedBackendProfile.id);
      return;
    }
    setRouteRepairing(true);
    try {
      if (action === "probe" && selectedBackendProfile) {
        await onProbeBackendProfile(
          selectedBackendProfile.id,
          conversation.modelSelection.modelId,
        );
      } else {
        onRefreshProvider(conversation.providerId);
      }
    } finally {
      if (mountedRef.current) setRouteRepairing(false);
    }
  };
  const submissionPending = primaryAction === "submitting";
  const followUpPending = followUpState === "pending";
  const reasoningLabel = selectedModel?.reasoningOptions.find(({ value }) => value === selectedReasoning)?.label ?? "Provider default";
  const updateReasoningEffort = (reasoningEffort: string): void => {
    onUpdateConversation(kimiSelection
      ? {
          modelSelection: {
            ...conversation.modelSelection,
            reasoningEffort,
          },
        }
      : { reasoningEffort });
  };
  const modelRoutes = buildComposerModelRoutes(
    providers,
    backendProfiles,
    conversation.modelSelection,
  );
  const selectedModelRoute = selectedModelSearchRoute(
    modelRoutes,
    conversation.modelSelection,
  );
  const chooseModelRoute = (route: ComposerModelRoute): void => {
    const transition = resolveModelRouteTransition({
      projectId: conversation.projectId,
      selection: conversation.modelSelection,
      continuationIdentity: conversation.continuationIdentity,
      latestTurn: latestTurn
        ? {
            selection: latestTurn.modelSelection,
            continuationIdentity: latestTurn.continuationIdentity,
          }
        : null,
      hasProviderSession: Boolean(conversation.providerSessionId),
    }, route);
    if (transition.kind === "create-new-conversation") {
      setPendingRoute({
        selection: transition.selection,
        label: `${route.backendProfileName} · ${route.displayName}`,
        reason: transition.reason,
      });
      return;
    }
    const providerId = route.providerId
      ?? legacyProviderIdForHarness(route.selection.harnessId);
    onUpdateConversation({
      ...(providerId ? { providerId } : {}),
      modelSelection: transition.selection,
    });
  };
  const updatePromptStash = (
    update: (current: readonly PromptStashEntry[]) => PromptStashEntry[],
  ): void => {
    setPromptStash((current) => {
      const next = update(current);
      if (writePromptStash(window.localStorage, next)) {
        window.dispatchEvent(new Event(PROMPT_STASH_CHANGED_EVENT));
      }
      return next;
    });
  };
  const stashCurrentPrompt = (): void => {
    if (!message.trim() || attachments.length > 0) return;
    updatePromptStash((current) => addPromptStashEntry(
      current,
      message,
      conversation.modelSelection,
    ));
    setMessage("");
    textareaRef.current?.focus();
  };
  const restoreStashedPrompt = (entry: PromptStashEntry): void => {
    if (
      attachments.length > 0
      || !promptStashRouteMatches(
        conversation.modelSelection,
        entry.route,
      )
    ) return;
    updatePromptStash((current) => {
      const withoutRestored = removePromptStashEntry(current, entry.id);
      return message.trim()
        ? addPromptStashEntry(
            withoutRestored,
            message,
            conversation.modelSelection,
          )
        : withoutRestored;
    });
    setMessage(entry.content);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const dismissPendingRoute = (): void => {
    setPendingRoute(null);
    window.requestAnimationFrame(() => {
      composerRef.current
        ?.querySelector<HTMLButtonElement>(".selected-model-chip")
        ?.focus();
    });
  };

  return (
    <div className="composer-shell">
      <section
        ref={composerRef}
        className={clsx("composer", menu && "has-open-menu")}
        aria-label="Message composer"
        aria-busy={submissionPending || followUpPending || running || stopping}
        data-primary-action={primaryAction}
        data-disabled={disabled}
        onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
        onDrop={(event) => { if (!event.dataTransfer.files.length) return; event.preventDefault(); void importAttachments([...event.dataTransfer.files]); }}
      >
        <ComposerInputZone
          routeReadiness={routeReadiness}
          routeRepairing={routeRepairing}
          disabled={disabled}
          onRunRouteRepair={runRouteRepair}
          promptContext={promptContext}
          onClearPromptContext={onClearPromptContext}
          attachments={attachments}
          onRemoveAttachment={removeAttachment}
          attachmentSendBoundary={attachmentSendBoundary}
          pendingRoute={pendingRoute}
          creatingRouteConversation={creatingRouteConversation}
          routeCancelRef={routeCancelRef}
          canCreateRouteConversation={Boolean(onCreateConversationForSelection)}
          onDismissPendingRoute={dismissPendingRoute}
          onCreateRouteConversation={() => {
            if (!onCreateConversationForSelection || !pendingRoute) return;
            setCreatingRouteConversation(true);
            void onCreateConversationForSelection(pendingRoute.selection).then(
              () => setPendingRoute(null),
              () => undefined,
            ).finally(() => setCreatingRouteConversation(false));
          }}
          textareaRef={textareaRef}
          message={message}
          setMessage={setMessage}
          onImportAttachments={importAttachments}
          onSubmit={submit}
          running={running}
          submissionPending={submissionPending}
          followUpPending={followUpPending}
          typedMessageLimit={typedMessageLimit}
          messageFits={messageFits}
          mentionMatch={mentionMatch}
          mentionResults={mentionResults}
          setFileReferences={setFileReferences}
          slashMatch={slashMatch}
          onUpdateConversation={onUpdateConversation}
        />
        <ComposerToolbar
          actions={actions}
          disabled={disabled}
          running={running}
          attachmentCount={attachments.length}
          onChooseAttachments={chooseAttachments}
          onRunAction={onRunAction}
          promptStash={promptStash}
          canStashPrompt={Boolean(message.trim()) && attachments.length === 0}
          promptStashBlockedReason={
            attachments.length > 0
              ? "Remove attachments before stashing text"
              : message.trim()
                ? null
                : "Type a prompt to stash"
          }
          promptRestoreBlockedReason={(entry) => {
            if (attachments.length > 0) {
              return "Remove attachments before restoring another prompt";
            }
            return promptStashRouteMatches(
              conversation.modelSelection,
              entry.route,
            )
              ? null
              : `Switch to ${entry.route.modelId} with ${
                  entry.route.reasoningEffort ?? "provider-default reasoning"
                } before restoring`;
          }}
          onStashPrompt={stashCurrentPrompt}
          onRestorePrompt={restoreStashedPrompt}
          onRemoveStashedPrompt={(entryId) =>
            updatePromptStash((current) =>
              removePromptStashEntry(current, entryId))}
          modelRoutes={modelRoutes}
          selectedModelRoute={selectedModelRoute}
          onChooseModelRoute={chooseModelRoute}
          selectedModel={selectedModel}
          selectedReasoning={selectedReasoning}
          reasoningLabel={reasoningLabel}
          onUpdateReasoningEffort={updateReasoningEffort}
          conversation={conversation}
          onUpdateConversation={onUpdateConversation}
          menuController={menuController}
          selectedProvider={selectedProvider}
          selectedBackendProfile={selectedBackendProfile}
          selectedIdentityLabel={selectedIdentityLabel}
          usage={usage}
          usageDisplayMode={usageDisplayMode}
          latestTurn={latestTurn}
          onUsageDisplayModeChange={onUsageDisplayModeChange}
          followUpState={followUpState}
          primaryAction={primaryAction}
          onSubmit={submit}
          onStop={stop}
        />
      </section>
    </div>
  );
}
