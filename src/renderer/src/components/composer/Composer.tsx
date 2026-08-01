import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { composerRouteReadiness } from "../../utils/composerReadiness";
import {
  buildComposerModelRoutes,
  selectedModelSearchRoute,
  type ComposerModelRoute,
} from "../../utils/modelChooserRoutes";
import { resolveModelRouteTransition } from "../../utils/modelRouteTransition";
import { buildComposerTurnRequest } from "../../utils/requestContext";
import { mergeComposerAttachments } from "../../utils/composerAttachments";
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
  persistPromptStashUpdate,
  PROMPT_STASH_CHANGED_EVENT,
  PROMPT_STASH_STORAGE_KEY,
  promptStashRouteMatches,
  readPromptStash,
  removePromptStashEntry,
  type PromptStashEntry,
} from "../../utils/promptStash";
import { ComposerInputZone } from "./ComposerInputZone";
import { ComposerToolbar } from "./ComposerToolbar";
import type { ComposerProps } from "./types";
import { useComposerMenus } from "./useComposerMenus";
import { useTextareaAutosize } from "./useTextareaAutosize";
import {
  COMPOSER_PREFILL_EVENT,
  type ComposerPrefillDetail,
} from "../../utils/composerPrefill";

export const DRAFT_PERSISTENCE_DELAY_MS = 275;

export const Composer = memo(function Composer({
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
  skills,
  skillsCapability,
  selectedSkillIds,
  skillsLoading,
  skillsError,
  promptContext,
  onSend,
  onListSkills,
  onToggleSkill,
  onClearSelectedSkills,
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
  const draftValueRef = useRef(message);
  const pendingDraftRef = useRef<{
    conversationId: string;
    value: string;
  } | null>(null);
  const draftPersistenceTimerRef = useRef<number | null>(null);
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
  const attachmentAuthorityRef = useRef(0);
  const submissionSequenceRef = useRef(0);
  const activeSubmissionsRef = useRef(new Map<string, number>());
  const editorRevisionSequenceRef = useRef(0);
  const editorRevisionsRef = useRef(new Map<string, number>());
  const stopSequenceRef = useRef(0);
  const activeStopsRef = useRef(new Map<string, number>());
  const promptContextsRef = useRef(new Map([
    [conversation.id, promptContext ?? null],
  ]));
  const releaseAttachmentRef = useRef(onReleaseAttachment);
  const [fileReferences, setFileReferences] = useState<string[]>([]);
  const [pendingRoute, setPendingRoute] = useState<{
    selection: ModelSelection;
    label: string;
    reason: string;
  } | null>(null);
  const [creatingRouteConversation, setCreatingRouteConversation] = useState(false);
  const [routeRepairing, setRouteRepairing] = useState(false);
  const [conversationUpdatePending, setConversationUpdatePending] = useState(false);
  const [conversationUpdateError, setConversationUpdateError] = useState<string | null>(null);
  const conversationUpdateSequenceRef = useRef(0);
  const menuController = useComposerMenus();
  const { menu, dismissMenu } = menuController;
  useNativePreviewSuspension(menu !== null);
  const composerRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const routeCancelRef = useRef<HTMLButtonElement>(null);
  const mentionMatch = /(?:^|\s)@([^\s@]{1,200})$/u.exec(message);
  const slashMatch = /^\/(\w*)$/u.exec(message.trim());

  conversationIdRef.current = conversation.id;

  const flushDraftPersistence = useCallback((): void => {
    if (draftPersistenceTimerRef.current !== null) {
      window.clearTimeout(draftPersistenceTimerRef.current);
      draftPersistenceTimerRef.current = null;
    }
    const pending = pendingDraftRef.current;
    pendingDraftRef.current = null;
    if (!pending) return;
    try {
      const key = `inertia:draft:${pending.conversationId}`;
      if (pending.value) window.localStorage.setItem(key, pending.value);
      else window.localStorage.removeItem(key);
    } catch {
      // Keep editing available when browser storage is unavailable.
    }
  }, []);

  const scheduleDraftPersistence = useCallback((
    conversationId: string,
    value: string,
  ): void => {
    if (draftPersistenceTimerRef.current !== null) {
      window.clearTimeout(draftPersistenceTimerRef.current);
    }
    pendingDraftRef.current = { conversationId, value };
    draftPersistenceTimerRef.current = window.setTimeout(
      flushDraftPersistence,
      DRAFT_PERSISTENCE_DELAY_MS,
    );
  }, [flushDraftPersistence]);

  const markEditorChanged = (conversationId = conversation.id): void => {
    editorRevisionSequenceRef.current += 1;
    editorRevisionsRef.current.set(
      conversationId,
      editorRevisionSequenceRef.current,
    );
  };

  useEffect(() => {
    const prefill = (event: Event): void => {
      const detail = (event as CustomEvent<ComposerPrefillDetail>).detail;
      if (
        !detail
        || detail.conversationId !== conversationIdRef.current
        || typeof detail.text !== "string"
      ) return;
      setMessage((current) => {
        const next = current.trim()
          ? `${current.trim()}\n\n${detail.text}`
          : detail.text;
        if (next !== current) {
          markEditorChanged(conversationIdRef.current);
          draftValueRef.current = next;
          scheduleDraftPersistence(conversationIdRef.current, next);
        }
        return next;
      });
      window.requestAnimationFrame(() => textareaRef.current?.focus());
    };
    window.addEventListener(COMPOSER_PREFILL_EVENT, prefill);
    return () => window.removeEventListener(COMPOSER_PREFILL_EVENT, prefill);
  }, [scheduleDraftPersistence]);

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
    const nextPromptContext = promptContext ?? null;
    const previousPromptContext = promptContextsRef.current.get(conversation.id);
    if (
      promptContextsRef.current.has(conversation.id)
      && previousPromptContext !== nextPromptContext
    ) {
      editorRevisionSequenceRef.current += 1;
      editorRevisionsRef.current.set(
        conversation.id,
        editorRevisionSequenceRef.current,
      );
    }
    promptContextsRef.current.set(conversation.id, nextPromptContext);
  }, [conversation.id, promptContext]);

  useEffect(() => {
    flushDraftPersistence();
    attachmentAuthorityRef.current += 1;
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
    const nextDraft = window.localStorage.getItem(
      `inertia:draft:${conversation.id}`,
    ) ?? "";
    draftValueRef.current = nextDraft;
    setMessage(nextDraft);
    for (const attachment of attachmentsRef.current) {
      void onReleaseAttachment(attachment.id);
    }
    attachmentsRef.current = [];
    setAttachments([]);
    setFileReferences([]);
    setPendingRoute(null);
    setCreatingRouteConversation(false);
    setRouteRepairing(false);
    conversationUpdateSequenceRef.current += 1;
    setConversationUpdatePending(false);
    setConversationUpdateError(null);
    dismissMenu("context-change");
  }, [
    conversation.id,
    dismissMenu,
    flushDraftPersistence,
    onReleaseAttachment,
  ]);

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
    activeStopsRef.current.delete(conversationIdRef.current);
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
    const flushBeforeUnload = (): void => flushDraftPersistence();
    window.addEventListener("beforeunload", flushBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", flushBeforeUnload);
      flushDraftPersistence();
    };
  }, [flushDraftPersistence]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      attachmentAuthorityRef.current += 1;
      const unsent = attachmentsRef.current;
      attachmentsRef.current = [];
      for (const attachment of unsent) {
        void releaseAttachmentRef.current(attachment.id);
      }
    };
  }, []);

  const mentionQuery = mentionMatch?.[1] ?? null;
  useEffect(() => {
    if (mentionQuery) onMentionQuery(mentionQuery);
  }, [mentionQuery, onMentionQuery]);

  useTextareaAutosize(textareaRef, message);

  const updateMessage = (next: string): void => {
    if (next === draftValueRef.current) return;
    markEditorChanged();
    draftValueRef.current = next;
    scheduleDraftPersistence(conversation.id, next);
    setMessage(next);
  };

  const addFileReference = (path: string): void => {
    if (fileReferences.includes(path)) return;
    markEditorChanged();
    setFileReferences([...fileReferences, path]);
  };

  const clearPromptContext = (): void => {
    if (!promptContext) return;
    markEditorChanged();
    promptContextsRef.current.set(conversation.id, null);
    onClearPromptContext?.();
  };

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
    flushDraftPersistence();
    const submittedAttachments = [...attachmentsRef.current];
    const submittedConversationId = conversation.id;
    const submittedDraft = message;
    const submittedPromptContext = promptContext;
    const submittedRevision =
      editorRevisionsRef.current.get(submittedConversationId) ?? 0;
    const submissionSequence = submissionSequenceRef.current + 1;
    submissionSequenceRef.current = submissionSequence;
    activeSubmissionsRef.current.set(
      submittedConversationId,
      submissionSequence,
    );
    // Submitted files must remain registered while the provider reads them.
    // Removing them from the unsent ref prevents an unmount from releasing
    // their temporary copies after the server has accepted the turn.
    attachmentsRef.current = [];
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onSend(
        request.visibleContent,
        submittedAttachments,
        request.context,
        running ? [] : selectedSkillIds,
      );
      const ownsSubmission =
        activeSubmissionsRef.current.get(submittedConversationId)
        === submissionSequence;
      if (!ownsSubmission) return;
      activeSubmissionsRef.current.delete(submittedConversationId);
      const editorUnchanged =
        (editorRevisionsRef.current.get(submittedConversationId) ?? 0)
          === submittedRevision
        && promptContextsRef.current.get(submittedConversationId)
          === (submittedPromptContext ?? null);
      if (editorUnchanged) {
        try {
          const key = `inertia:draft:${submittedConversationId}`;
          if (window.localStorage.getItem(key) === submittedDraft) {
            window.localStorage.removeItem(key);
          }
        } catch {
          // The accepted in-memory draft can still settle when storage is unavailable.
        }
      }
      if (
        !mountedRef.current
        || conversationIdRef.current !== submittedConversationId
      ) return;
      onClearSelectedSkills();
      if (editorUnchanged) {
        draftValueRef.current = "";
        setMessage("");
        setAttachments([]);
        setFileReferences([]);
        promptContextsRef.current.set(submittedConversationId, null);
        onClearPromptContext?.();
      }
      textareaRef.current?.focus();
      submissionReleaseTimerRef.current = window.setTimeout(() => {
        submissionReleaseTimerRef.current = null;
        submittingRef.current = false;
        if (mountedRef.current && conversationIdRef.current === submittedConversationId) {
          setSubmitting(false);
        }
      }, COMPOSER_ACTION_STALE_FALLBACK_MS);
    } catch {
      const ownsSubmission =
        activeSubmissionsRef.current.get(submittedConversationId)
        === submissionSequence;
      if (ownsSubmission) {
        activeSubmissionsRef.current.delete(submittedConversationId);
      }
      const ownsCurrentComposer = ownsSubmission
        && mountedRef.current
        && conversationIdRef.current === submittedConversationId
      const editorUnchanged =
        (editorRevisionsRef.current.get(submittedConversationId) ?? 0)
          === submittedRevision
        && promptContextsRef.current.get(submittedConversationId)
          === (submittedPromptContext ?? null);
      if (ownsCurrentComposer && editorUnchanged) {
        setMessage(submittedDraft);
        attachmentsRef.current = submittedAttachments;
        setAttachments(submittedAttachments);
      } else {
        for (const attachment of submittedAttachments) {
          void releaseAttachmentRef.current(attachment.id);
        }
      }
      // The workspace-level toast presents the failure; the current composer
      // keeps failed attachments available for retry when it is still mounted.
      if (ownsCurrentComposer) {
        submittingRef.current = false;
        setSubmitting(false);
        textareaRef.current?.focus();
      }
    }
  };

  const stop = async (): Promise<void> => {
    if (stoppingRef.current || !running) return;
    const stoppedConversationId = conversation.id;
    const stopSequence = stopSequenceRef.current + 1;
    stopSequenceRef.current = stopSequence;
    activeStopsRef.current.set(stoppedConversationId, stopSequence);
    stoppingRef.current = true;
    setStopping(true);
    try {
      await onStop();
      if (
        activeStopsRef.current.get(stoppedConversationId) !== stopSequence
      ) return;
      if (
        !mountedRef.current
        || conversationIdRef.current !== stoppedConversationId
      ) {
        activeStopsRef.current.delete(stoppedConversationId);
        return;
      }
      stopReleaseTimerRef.current = window.setTimeout(() => {
        stopReleaseTimerRef.current = null;
        if (
          activeStopsRef.current.get(stoppedConversationId) !== stopSequence
        ) return;
        activeStopsRef.current.delete(stoppedConversationId);
        stoppingRef.current = false;
        if (mountedRef.current && conversationIdRef.current === stoppedConversationId) {
          setStopping(false);
        }
      }, COMPOSER_ACTION_STALE_FALLBACK_MS);
    } catch {
      if (
        activeStopsRef.current.get(stoppedConversationId) !== stopSequence
      ) return;
      activeStopsRef.current.delete(stoppedConversationId);
      stoppingRef.current = false;
      if (mountedRef.current && conversationIdRef.current === stoppedConversationId) {
        setStopping(false);
      }
    }
  };

  const addAttachments = (incoming: readonly ChatAttachment[]): void => {
    const merged = mergeComposerAttachments(attachmentsRef.current, incoming);
    const changed = merged.attachments.length !== attachmentsRef.current.length
      || merged.attachments.some(
        ({ id }, index) => id !== attachmentsRef.current[index]?.id,
      );
    if (changed) markEditorChanged();
    attachmentsRef.current = merged.attachments;
    setAttachments(merged.attachments);
    for (const attachment of merged.rejected) {
      void onReleaseAttachment(attachment.id);
    }
  };

  const removeAttachment = (attachment: ChatAttachment): void => {
    if (!attachmentsRef.current.some(({ id }) => id === attachment.id)) return;
    markEditorChanged();
    const next = attachmentsRef.current.filter(({ id }) => id !== attachment.id);
    attachmentsRef.current = next;
    setAttachments(next);
    void onReleaseAttachment(attachment.id);
  };

  const chooseAttachments = async () => {
    if (submittingRef.current || disabled || sending || running) return;
    const authority = attachmentAuthorityRef.current;
    const attachmentConversationId = conversation.id;
    const selected = await onChooseAttachments();
    if (
      !mountedRef.current
      || attachmentAuthorityRef.current !== authority
      || conversationIdRef.current !== attachmentConversationId
    ) {
      for (const attachment of selected) {
        void releaseAttachmentRef.current(attachment.id);
      }
      return;
    }
    addAttachments(selected);
  };

  const importAttachments = async (files: File[]) => {
    if (submittingRef.current || disabled || sending || running) return;
    const authority = attachmentAuthorityRef.current;
    const attachmentConversationId = conversation.id;
    const remaining = Math.max(0, MAX_CHAT_ATTACHMENTS - attachmentsRef.current.length);
    const candidates = files.slice(0, remaining);
    if (candidates.length === 0) return;
    const selected = await onImportAttachments(candidates);
    if (
      !mountedRef.current
      || attachmentAuthorityRef.current !== authority
      || conversationIdRef.current !== attachmentConversationId
    ) {
      for (const attachment of selected) {
        void releaseAttachmentRef.current(attachment.id);
      }
      return;
    }
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
  const sendEligible = (Boolean(message.trim()) || attachments.length > 0 || Boolean(promptContext))
    && messageFits
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
      && selectedSkillIds.length === 0
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
  const updateConversation = async (
    update: Parameters<ComposerProps["onUpdateConversation"]>[0],
  ): Promise<void> => {
    const sequence = conversationUpdateSequenceRef.current + 1;
    conversationUpdateSequenceRef.current = sequence;
    setConversationUpdatePending(true);
    setConversationUpdateError(null);
    try {
      await onUpdateConversation(update);
    } catch (error) {
      if (mountedRef.current && conversationUpdateSequenceRef.current === sequence) {
        setConversationUpdateError(
          error instanceof Error
            ? error.message
            : "The conversation setting could not be updated.",
        );
      }
      throw error;
    } finally {
      if (mountedRef.current && conversationUpdateSequenceRef.current === sequence) {
        setConversationUpdatePending(false);
      }
    }
  };
  const updateReasoningEffort = (reasoningEffort: string): void => {
    void updateConversation(kimiSelection
      ? {
          modelSelection: {
            ...conversation.modelSelection,
            reasoningEffort,
          },
        }
      : { reasoningEffort }).catch(() => undefined);
  };
  const modelRoutes = useMemo(() => buildComposerModelRoutes(
    providers,
    backendProfiles,
    conversation.modelSelection,
  ), [backendProfiles, conversation.modelSelection, providers]);
  const selectedModelRoute = useMemo(() => selectedModelSearchRoute(
    modelRoutes,
    conversation.modelSelection,
  ), [conversation.modelSelection, modelRoutes]);
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
    void updateConversation({
      ...(providerId ? { providerId } : {}),
      modelSelection: transition.selection,
    }).catch(() => undefined);
  };
  const updatePromptStash = (
    update: (current: readonly PromptStashEntry[]) => PromptStashEntry[],
  ): boolean => {
    const next = persistPromptStashUpdate(
      window.localStorage,
      promptStash,
      update,
    );
    if (!next) return false;
    setPromptStash(next);
    window.dispatchEvent(new Event(PROMPT_STASH_CHANGED_EVENT));
    return true;
  };
  const stashCurrentPrompt = (): void => {
    if (!message.trim() || attachments.length > 0) return;
    const persisted = updatePromptStash((current) => addPromptStashEntry(
      current,
      message,
      conversation.modelSelection,
    ));
    if (!persisted) return;
    updateMessage("");
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
    const persisted = updatePromptStash((current) => {
      const withoutRestored = removePromptStashEntry(current, entry.id);
      return message.trim()
        ? addPromptStashEntry(
            withoutRestored,
            message,
            conversation.modelSelection,
          )
        : withoutRestored;
    });
    if (!persisted) return;
    updateMessage(entry.content);
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
        aria-busy={
          submissionPending
          || followUpPending
          || running
          || stopping
          || conversationUpdatePending
        }
        data-primary-action={primaryAction}
        data-disabled={disabled || conversationUpdatePending}
        onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
        onDrop={(event) => { if (!event.dataTransfer.files.length) return; event.preventDefault(); void importAttachments([...event.dataTransfer.files]); }}
      >
        <ComposerInputZone
          routeReadiness={routeReadiness}
          routeRepairing={routeRepairing}
          disabled={disabled || conversationUpdatePending}
          onRunRouteRepair={runRouteRepair}
          promptContext={promptContext}
          onClearPromptContext={clearPromptContext}
          attachments={attachments}
          onRemoveAttachment={removeAttachment}
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
          onMessageChange={updateMessage}
          onImportAttachments={importAttachments}
          onSubmit={submit}
          running={running}
          submissionPending={submissionPending}
          followUpPending={followUpPending}
          typedMessageLimit={typedMessageLimit}
          messageFits={messageFits}
          mentionMatch={mentionMatch}
          mentionResults={mentionResults}
          onAddFileReference={addFileReference}
          slashMatch={slashMatch}
          onUpdateConversation={updateConversation}
        />
        <ComposerToolbar
          actions={actions}
          disabled={disabled || conversationUpdatePending}
          running={running}
          attachmentCount={attachments.length}
          onChooseAttachments={chooseAttachments}
          onRunAction={onRunAction}
          skills={skills}
          skillsCapability={skillsCapability}
          selectedSkillIds={selectedSkillIds}
          skillsLoading={skillsLoading}
          skillsError={skillsError}
          onListSkills={onListSkills}
          onToggleSkill={onToggleSkill}
          onClearSelectedSkills={onClearSelectedSkills}
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
          onUpdateConversation={updateConversation}
          conversationUpdatePending={conversationUpdatePending}
          conversationUpdateError={conversationUpdateError}
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
});
