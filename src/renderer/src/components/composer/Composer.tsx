import "./ComposerSurface.css";
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { ChatAttachment, PromptPreset } from "@shared/contracts";
import { chatAttachmentKind } from "@shared/attachments";
import { MAX_CHAT_MESSAGE_CHARS } from "../../../../shared/diff-review";
import { fastModeProviderValue, providerIdForHarness, routeSupportsNativeFastModeIdentity, withModelSelectionFastMode } from "../../../../shared/model-routing";
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { resolveComposerRouteState } from "../../utils/composerRouteState";
import {
  buildComposerModelRoutes,
  selectedModelSearchRoute,
  type ComposerModelRoute,
} from "../../utils/modelChooserRoutes";
import { resolveModelRouteTransition } from "../../utils/modelRouteTransition";
import { buildComposerTurnRequest } from "../../utils/requestContext";
import {
  COMPOSER_ACTION_STALE_FALLBACK_MS,
  composerFollowUpState,
  composerPrimaryActionState,
} from "../../utils/composerPrimaryAction";
import { composerHarnessLabel } from "./config";
import {
  addPromptStashEntry,
  advanceRecurringPrompt,
  persistPromptStashUpdate,
  PROMPT_STASH_CHANGED_EVENT,
  promptStashRouteMatches,
  promptStashRestoreBlockedReason,
  removePromptStashEntry,
  setPromptStashRecurrence,
  type PromptStashEntry,
} from "../../utils/promptStash";
import { ComposerInputZone } from "./ComposerInputZone";
import { ComposerToolbar } from "./ComposerToolbar";
import type { ComposerProps, PendingModelRoute } from "./types";
import { useComposerMenus } from "./useComposerMenus";
import { useTextareaAutosize } from "./useTextareaAutosize";
import { parseCompactComposerCommand } from "../../utils/composerCommands";
import { useComposerCompaction } from "./useComposerCompaction";
import { composerAttachmentActions } from "./composerAttachmentActions";
import { insertComposerSkillToken } from "../../utils/composerSkillToken";
import { ComposerConversationContextDialog, ComposerConversationContextStrip, composerConversationContextToolbarProps, useComposerConversationContext } from "./useComposerConversationContext";
import { useComposerDetachmentOwnership } from "./useComposerDetachmentOwnership";
import { useComposerPrefill } from "./useComposerPrefill";
import { useComposerPromptStash } from "./useComposerPromptStash";
import { useComposerPromptHistory } from "./useComposerPromptHistory";
import { useComposerSkillCompletion } from "./useComposerSkillCompletion";
import { clearPersistedComposerDraft, persistComposerDraft } from "../../utils/composerDraftPersistence";
/*
 * The resume surface only matters once /resume runs, and the composer sits in
 * the entry chunk. Loading it on demand keeps the picker and its list rendering
 * out of first paint.
 */
const ChatResumeControl = lazy(async () => ({ default: (await import("../ChatResumeControl")).ChatResumeControl }));
const ChatGoalControl = lazy(async () => ({ default: (await import("../ChatGoalControl")).ChatGoalControl }));
export const DRAFT_PERSISTENCE_DELAY_MS = 275;
// The first non-empty edit is synchronous. During uninterrupted typing, a
// force-terminated renderer can lose at most this much newer draft history;
// ordinary lifecycle boundaries still flush the exact pending owner/value.
export const DRAFT_PERSISTENCE_MAX_WAIT_MS = 1_000;
const ignorePromptPresetMutation = (): Promise<void> => Promise.resolve();
const unavailableCompaction = (): Promise<never> => Promise.reject(new Error(
  "Compaction unavailable.",
));

export const Composer = memo(function Composer({
  conversation,
  checkoutBranch,
  showCheckoutContext = true,
  newChatProjectPicker,
  providers,
  actions,
  disabled,
  sending,
  running,
  backendProfiles = [],
  latestTurn = null,
  promptHistory = [],
  latestTurnSummary = null,
  queuedTurnAuthoritative = true,
  mentionResults,
  usage,
  usageDisplayMode,
  skills,
  skillsCapability,
  skillsLoading, skillsError,
  conversationContextHandoffEnabled = true, promptContext,
  contextSources = [], contextPackets = [],
  agentContextRequest = null, onConversationContextCommand,
  previewContextUrl,
  providerIdentityLabels,
  goal,
  onSend,
  onCompact = unavailableCompaction,
  onListSkills, promptPresets = [], promptPresetsEnabled = true,
  promptStashEnabled = true,
  onPromptPresetCommand = ignorePromptPresetMutation,
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
  onOpenResume,
  resumeOptions,
  onResumeConversation,
  onStop,
  onClearPromptContext,
}: ComposerProps): React.JSX.Element {
  const [message, setMessage] = useState(
    () => window.localStorage.getItem(`inertia:draft:${conversation.id}`) ?? "",
  );
  const [promptStash, setPromptStash] = useComposerPromptStash(
    promptStashEnabled,
  );
  const draftValueRef = useRef(message);
  const pendingDraftRef = useRef<{
    conversationId: string;
    value: string;
  } | null>(null);
  const draftPersistenceTimerRef = useRef<number | null>(null);
  const draftPersistenceMaxWaitTimerRef = useRef<number | null>(null);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]); const [pendingAttachmentIds, setPendingAttachmentIds] = useState<ReadonlySet<string>>(() => new Set()); const pendingAttachmentIdsRef = useRef(new Set<string>());
  const [attachmentImporting, setAttachmentImporting] = useState(false); const attachmentImportingRef = useRef(false); const attachmentImportSequenceRef = useRef(0);
  const conversationContext = useComposerConversationContext({ conversationId: conversation.id, contextPackets, enabled: conversationContextHandoffEnabled, onCommand: onConversationContextCommand });
  const { contextPacketIds } = conversationContext;
  const attachmentsRef = useRef<ChatAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const submissionReleaseTimerRef = useRef<number | null>(null);
  const [stopping, setStopping] = useState(false);
  const stoppingRef = useRef(false);
  const stopReleaseTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const conversationIdRef = useRef(conversation.id);
  const attachmentAuthorityKey = JSON.stringify([conversation.id, running, latestTurn?.id ?? null, latestTurn?.harnessId ?? null]); const attachmentAuthorityRef = useRef({ key: attachmentAuthorityKey, conversationId: conversation.id });
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
  const [previewContextSelected, setPreviewContextSelected] = useState(false);
  const selectedPreviewUrlRef = useRef<string | null>(null);
  const [pendingRoute, setPendingRoute] = useState<PendingModelRoute | null>(null);
  const [creatingRouteConversation, setCreatingRouteConversation] = useState(false);
  const [routeCreationError, setRouteCreationError] = useState<string | null>(null);
  const [routeRepairing, setRouteRepairing] = useState(false);
  const [conversationUpdatePending, setConversationUpdatePending] = useState(false);
  const [conversationUpdateError, setConversationUpdateError] = useState<string | null>(null);
  const [commandSurface, setCommandSurface] = useState<"goal" | "resume" | null>(null);
  const conversationUpdateSequenceRef = useRef(0);
  const menuController = useComposerMenus();
  const { menu, dismissMenu } = menuController;
  useNativePreviewSuspension(menu !== null);
  useNativePreviewSuspension(conversationContext.dialog !== null || agentContextRequest !== null);
  const composerRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const routeCancelRef = useRef<HTMLButtonElement>(null);
  const mentionMatch = /(?:^|\s)@([^\s@]{1,200})$/u.exec(message);
  const skillCompletion = useComposerSkillCompletion(skills, message, menu === "skills");
  const slashMatch = /^\/(\w*)$/u.exec(message.trim());
  const dismissCommandSurface = useCallback((
    reason: "action" | "escape" | "outside" | "owner-change",
  ) => {
    setCommandSurface(null);
    if (reason === "action" || reason === "escape") {
      window.requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, []);

  conversationIdRef.current = conversation.id;
  useLayoutEffect(() => { attachmentAuthorityRef.current = { key: attachmentAuthorityKey, conversationId: conversation.id }; return () => { if (attachmentAuthorityRef.current.key === attachmentAuthorityKey) attachmentAuthorityRef.current = { key: "", conversationId: "" }; }; }, [attachmentAuthorityKey, conversation.id]);

  const flushDraftPersistence = useCallback((): void => {
    if (draftPersistenceTimerRef.current !== null) {
      window.clearTimeout(draftPersistenceTimerRef.current);
      draftPersistenceTimerRef.current = null;
    }
    if (draftPersistenceMaxWaitTimerRef.current !== null) {
      window.clearTimeout(draftPersistenceMaxWaitTimerRef.current);
      draftPersistenceMaxWaitTimerRef.current = null;
    }
    const pending = pendingDraftRef.current;
    pendingDraftRef.current = null;
    if (!pending) return;
    persistComposerDraft(pending.conversationId, pending.value);
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
    if (draftPersistenceMaxWaitTimerRef.current === null) {
      draftPersistenceMaxWaitTimerRef.current = window.setTimeout(
        flushDraftPersistence,
        DRAFT_PERSISTENCE_MAX_WAIT_MS,
      );
    }
  }, [flushDraftPersistence]);

  const persistDraftChange = useCallback((
    conversationId: string,
    previous: string,
    next: string,
  ): void => {
    if (!previous && next) {
      // Make the first recoverable character durable immediately. Later edits
      // coalesce for 275 ms, with a one-second maximum loss window while the
      // user types continuously.
      pendingDraftRef.current = { conversationId, value: next };
      flushDraftPersistence();
      return;
    }
    scheduleDraftPersistence(conversationId, next);
  }, [flushDraftPersistence, scheduleDraftPersistence]);

  useComposerDetachmentOwnership({
    conversationId: conversation.id,
    flushDraftPersistence,
    readDraft: () => draftValueRef.current,
    readState: () => ({
      attachmentCount: attachmentsRef.current.length,
      conversationContextPending: conversationContextHandoffEnabled && (conversationContext.draftContextPackets.length > 0 || conversationContext.dialog !== null || agentContextRequest !== null),
      fileReferenceCount: fileReferences.length,
      mutationInFlight: attachmentImportingRef.current || submittingRef.current
        || stoppingRef.current
        || creatingRouteConversation
        || routeRepairing
        || conversationUpdatePending,
      pendingModelRoute: pendingRoute !== null,
      previewContextSelected: selectedPreviewUrlRef.current !== null,
      promptContextSelected: Boolean(promptContext),
    }),
  });

  const markEditorChanged = (conversationId = conversation.id): void => {
    editorRevisionSequenceRef.current += 1;
    editorRevisionsRef.current.set(
      conversationId,
      editorRevisionSequenceRef.current,
    );
  };

  useComposerPrefill({
    conversationIdRef,
    draftValueRef,
    markEditorChanged,
    persistDraftChange,
    setMessage,
    textareaRef,
  });

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
    if (!previewContextSelected) return;
    const next = previewContextUrl ?? null;
    if (selectedPreviewUrlRef.current === next) return;
    selectedPreviewUrlRef.current = next;
    editorRevisionSequenceRef.current += 1;
    editorRevisionsRef.current.set(
      conversation.id,
      editorRevisionSequenceRef.current,
    );
    if (!next) setPreviewContextSelected(false);
  }, [conversation.id, previewContextSelected, previewContextUrl]);

  useEffect(() => {
    flushDraftPersistence();
    attachmentImportSequenceRef.current += 1; attachmentImportingRef.current = false; setAttachmentImporting(false);
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
    setAttachments([]); pendingAttachmentIdsRef.current = new Set(); setPendingAttachmentIds(new Set());
    setFileReferences([]);
    selectedPreviewUrlRef.current = null;
    setPreviewContextSelected(false);
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
      const retainedImages = attachmentsRef.current.filter(
        ({ mimeType }) => chatAttachmentKind(mimeType) === "image",
      );
      for (const attachment of attachmentsRef.current) {
        if (chatAttachmentKind(attachment.mimeType) !== "image") {
          void releaseAttachmentRef.current(attachment.id);
        }
      }
      if (retainedImages.length !== attachmentsRef.current.length) {
        attachmentsRef.current = retainedImages;
        setAttachments(() => retainedImages);
      }
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
    let settleFrame = 0;
    const closeFrame = window.requestAnimationFrame(() => {
      settleFrame = window.requestAnimationFrame(() =>
        routeCancelRef.current?.focus());
    });
    return () => {
      window.cancelAnimationFrame(closeFrame);
      if (settleFrame) window.cancelAnimationFrame(settleFrame);
    };
  }, [pendingRoute]);

  useEffect(() => {
    if (!pendingRoute) return;
    const latestTurnAuthority = latestTurnSummary ?? latestTurn;
    const latestTurnId = latestTurnAuthority?.id ?? null;
    const latestTurnKey = JSON.stringify(latestTurnAuthority
      ? {
          id: latestTurnAuthority.id,
          modelSelection: latestTurnAuthority.modelSelection,
          continuationIdentity: latestTurnAuthority.continuationIdentity,
        }
      : null);
    const destinationRevision = backendProfiles.find(({ id }) =>
      id === pendingRoute.selection.backendProfileId)
      ?.configurationRevision
      ?? pendingRoute.selection.backendConfigurationRevision;
    if (
      pendingRoute.sourceConversationId !== conversation.id
      || pendingRoute.sourceProjectId !== conversation.projectId
      || pendingRoute.sourceSelectionKey !== JSON.stringify(conversation.modelSelection)
      || pendingRoute.sourceContinuationKey
        !== JSON.stringify(conversation.continuationIdentity)
      || pendingRoute.sourceLatestTurnId !== latestTurnId
      || pendingRoute.sourceLatestTurnKey !== latestTurnKey
      || pendingRoute.destinationRevision !== destinationRevision
    ) {
      setPendingRoute(null);
      setRouteCreationError(null);
    }
  }, [
    conversation.continuationIdentity,
    conversation.id,
    conversation.modelSelection,
    conversation.projectId,
    backendProfiles,
    latestTurn,
    latestTurnSummary,
    pendingRoute,
  ]);

  useEffect(() => () => {
    if (submissionReleaseTimerRef.current !== null) window.clearTimeout(submissionReleaseTimerRef.current);
    if (stopReleaseTimerRef.current !== null) window.clearTimeout(stopReleaseTimerRef.current);
  }, []);

  useEffect(() => {
    const flushBeforeUnload = (): void => {
      flushDraftPersistence();
      const unsent = attachmentsRef.current;
      attachmentsRef.current = [];
      for (const attachment of unsent) {
        void releaseAttachmentRef.current(attachment.id);
      }
    };
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
      const unsent = attachmentsRef.current;
      attachmentsRef.current = [];
      for (const attachment of unsent) {
        void releaseAttachmentRef.current(attachment.id);
      }
    };
  }, []);

  const mentionQuery = mentionMatch?.[1] ?? null;
  useEffect(() => { if (mentionQuery) onMentionQuery(mentionQuery); }, [mentionQuery, onMentionQuery]);

  useTextareaAutosize(textareaRef, message);

  const applyMessage = (next: string): void => {
    const previous = draftValueRef.current;
    if (next === previous) return;
    markEditorChanged(); draftValueRef.current = next;
    persistDraftChange(conversation.id, previous, next);
    if (compactNotice) clearCompactNotice(); setMessage(next);
  };

  const promptHistoryController = useComposerPromptHistory({
    conversationId: conversation.id, entries: promptHistory, latestTurn: latestTurnSummary ?? latestTurn, message,
    onApplyMessage: applyMessage, readEditorRevision: () => editorRevisionsRef.current.get(conversation.id) ?? 0,
    canRestoreStoppedPrompt: () => draftValueRef.current.length === 0 && attachmentsRef.current.length === 0 && pendingAttachmentIdsRef.current.size === 0 && !attachmentImportingRef.current && !submittingRef.current && !promptContext && selectedPreviewUrlRef.current === null && fileReferences.length === 0 && contextPacketIds.length === 0 && pendingRoute === null, textareaRef,
  });
  const updateMessage = promptHistoryController.replaceMessage;

  const addFileReference = (path: string): void => {
    if (fileReferences.includes(path)) return;
    markEditorChanged(); setFileReferences([...fileReferences, path]);
  };

  const clearPromptContext = (): void => { if (promptContext) { markEditorChanged(); promptContextsRef.current.set(conversation.id, null); onClearPromptContext?.(); } };

  const togglePreviewContext = (): void => {
    markEditorChanged();
    const next = selectedPreviewUrlRef.current ? null : previewContextUrl ?? null;
    selectedPreviewUrlRef.current = next;
    setPreviewContextSelected(Boolean(next));
  };

  const submit = async () => {
    if (attachmentImportingRef.current) return;
    const compactCommand = parseCompactComposerCommand(message);
    if (compactCommand) {
      await compact(compactCommand);
      return;
    }
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
          selectedPreviewUrlRef.current,
          contextPacketIds,
        );
    if ((!canSend && followUpState !== "ready") || submittingRef.current) return;
    flushDraftPersistence();
    const submittedAttachments = [...attachmentsRef.current];
    const submittedConversationId = conversation.id;
    const submittedDraft = message;
    const submittedPromptContext = promptContext;
    const submittedPreviewUrl = selectedPreviewUrlRef.current;
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
        running ? request.visibleContent || attachmentFallback : request.visibleContent,
        submittedAttachments,
        request.context,
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
          === (submittedPromptContext ?? null)
        && selectedPreviewUrlRef.current === submittedPreviewUrl;
      if (editorUnchanged) {
        clearPersistedComposerDraft(submittedConversationId, submittedDraft);
      }
      if (!mountedRef.current || conversationIdRef.current !== submittedConversationId) return;
      if (editorUnchanged) {
        promptHistoryController.reset(""); draftValueRef.current = "";
        setMessage("");
        setAttachments([]);
        setFileReferences([]);
        selectedPreviewUrlRef.current = null;
        setPreviewContextSelected(false);
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
          === (submittedPromptContext ?? null)
        && selectedPreviewUrlRef.current === submittedPreviewUrl;
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

  const { chooseAttachments, importAttachments, removeAttachment } =
    composerAttachmentActions({
      attachmentAuthorityRef,
      attachmentAuthorityKey,
      attachmentImportSequenceRef,
      attachmentImportingRef,
      attachmentsRef, pendingAttachmentIdsRef,
      blocked: disabled || sending,
      conversationId: conversation.id,
      markEditorChanged,
      mountedRef,
      onChooseAttachments,
      onImportAttachments,
      releaseAttachmentRef,
      running,
      setAttachments,
      setAttachmentImporting, setPendingAttachmentIds,
      submittingRef,
    });

  const routeState = useMemo(() => resolveComposerRouteState({
    conversationProviderId: conversation.providerId,
    selection: conversation.modelSelection,
    providers,
    profiles: backendProfiles,
  }), [
    backendProfiles,
    conversation.modelSelection,
    conversation.providerId,
    providers,
  ]);
  const selectedProvider = routeState.provider;
  const selectedBackendProfile = routeState.profile;
  const selectedModel = routeState.model;
  const selectedReasoning = conversation.modelSelection.reasoningEffort
    ?? selectedModel?.defaultReasoningEffort
    ?? "";
  const selectedFastMode = fastModeProviderValue(conversation.modelSelection) !== null;
  const routeReadiness = routeState.readiness;
  const selectedIdentityLabel = selectedBackendProfile
    ? `${composerHarnessLabel(selectedBackendProfile.harnessId)} · ${selectedBackendProfile.displayName} · ${selectedModel?.label ?? conversation.modelSelection.modelId}`
    : selectedProvider
      ? `${providerIdentityLabels?.[selectedProvider.id] ?? selectedProvider.label} · ${selectedModel?.label ?? conversation.modelSelection.modelId}`
      : conversation.modelSelection.backendProfileDisplayName;
  const attachmentFallback = running
    ? "Please inspect the attached image."
    : "Please inspect the attached file.";
  const composedLength = (message.trim() || (attachments.length > 0 ? attachmentFallback : selectedPreviewUrlRef.current ? "Please inspect the current preview." : contextPacketIds.length > 0 ? "Please use the selected chat context." : "Please review the selected diff context.")).length;
  const typedMessageLimit = MAX_CHAT_MESSAGE_CHARS;
  const messageFits = composedLength <= MAX_CHAT_MESSAGE_CHARS;
  const sendEligible = (Boolean(message.trim()) || attachments.length > 0 || Boolean(promptContext) || previewContextSelected || contextPacketIds.length > 0)
    && messageFits
    && routeReadiness.ready
    && !disabled
    && !attachmentImporting
    && !conversationUpdatePending;
  const primaryAction = composerPrimaryActionState({
    sendEligible,
    submitting,
    sending,
    running,
    stopping,
  });
  const canSend = primaryAction === "send-ready";
  const attachmentsAreImages = attachments.every(({ mimeType }) => chatAttachmentKind(mimeType) === "image");
  const { compactNotice, clearCompactNotice, compact, compactUnavailableReason } = useComposerCompaction({
    conversationId: conversation.id, providerId: conversation.providerId, message, canSend, running,
    blocked: attachments.length > 0
      || Boolean(promptContext)
      || previewContextSelected
      || fileReferences.length > 0
      || contextPacketIds.length > 0,
    flushDraftPersistence, conversationIdRef, mountedRef, submittingRef,
    editorRevisions: editorRevisionsRef,
    draftValueRef, textareaRef, clearMessage: () => { promptHistoryController.reset(""); setMessage(""); }, setSubmitting, onCompact,
  });
  const followUpState = composerFollowUpState({
    running,
    harnessId: latestTurn?.harnessId ?? null,
    hasDraft: Boolean(message.trim()) || attachments.length > 0,
    textOnly:
      attachmentsAreImages
      && !promptContext
      && !previewContextSelected
      && fileReferences.length === 0
      && messageFits
      && !disabled,
    submitting,
    sending,
  });
  const canQueue = running && sendEligible && attachmentsAreImages && !promptContext
    && !previewContextSelected && fileReferences.length === 0 && contextPacketIds.length === 0 && !submitting && !sending;
  const queueCurrentMessage = async (): Promise<void> => {
    if (!canQueue) return;
    const queuedConversationId = conversation.id;
    const queuedMessage = message;
    const queuedAttachments = attachmentsRef.current;
    const { enqueueComposerPrompt } = await import("./ComposerQueuedActions");
    if (conversationIdRef.current !== queuedConversationId || draftValueRef.current !== queuedMessage
      || attachmentsRef.current !== queuedAttachments || !enqueueComposerPrompt(
        queuedConversationId, queuedMessage.trim() || attachmentFallback, queuedAttachments,
      )) return;
    attachmentsRef.current = []; setAttachments([]);
    pendingAttachmentIdsRef.current = new Set(); setPendingAttachmentIds(new Set());
    flushDraftPersistence(); clearPersistedComposerDraft(queuedConversationId, queuedMessage);
    markEditorChanged(); promptHistoryController.reset(""); draftValueRef.current = ""; setMessage(""); window.requestAnimationFrame(() => textareaRef.current?.focus());
  };
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
    if (action === "configure") {
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
  const updateReasoningEffort = async (
    reasoningEffort: string,
  ): Promise<void> => {
    await updateConversation({
      modelSelection: {
        ...conversation.modelSelection,
        reasoningEffort,
      },
    });
  };
  const updateFastMode = async (enabled: boolean): Promise<void> => {
    const providerValue = enabled
      ? selectedModel?.fastMode?.providerValue ?? null
      : null;
    if (enabled && !providerValue) {
      throw new Error("Fast mode is unavailable.");
    }
    const modelSelection = withModelSelectionFastMode(
      conversation.modelSelection,
      providerValue,
    );
    if (
      JSON.stringify(modelSelection.providerOptions)
      === JSON.stringify(conversation.modelSelection.providerOptions)
    ) return;
    await updateConversation({ modelSelection });
  };
  const modelRoutes = useMemo(() => buildComposerModelRoutes(
    providers,
    backendProfiles,
    conversation.modelSelection,
    providerIdentityLabels,
  ), [backendProfiles, conversation.modelSelection, providerIdentityLabels, providers]);
  const selectedModelRoute = useMemo(() => selectedModelSearchRoute(
    modelRoutes,
    conversation.modelSelection,
  ), [conversation.modelSelection, modelRoutes]);
  const chooseModelRoute = async (route: ComposerModelRoute): Promise<void> => {
    const transition = resolveModelRouteTransition({
      projectId: conversation.projectId,
      selection: conversation.modelSelection,
      continuationIdentity: conversation.continuationIdentity,
      latestTurn: latestTurnSummary
        ? {
            selection: latestTurnSummary.modelSelection,
            continuationIdentity: latestTurnSummary.continuationIdentity,
          }
        : latestTurn
          ? {
              selection: latestTurn.modelSelection,
              continuationIdentity: latestTurn.continuationIdentity,
            }
        : null,
      hasProviderSession: Boolean(conversation.providerSessionId),
    }, route);
    if (transition.kind === "create-new-conversation") {
      if (!onCreateConversationForSelection) {
        setConversationUpdateError(
          "Return this chat to the main window to choose a model that requires a new chat.",
        );
        return;
      }
      const sourceLatestTurn = latestTurnSummary ?? latestTurn;
      setRouteCreationError(null);
      setPendingRoute({
        selection: transition.selection,
        label: `${route.backendProfileName} · ${route.displayName}`,
        reason: transition.reason,
        sourceConversationId: conversation.id,
        sourceProjectId: conversation.projectId,
        sourceSelectionKey: JSON.stringify(conversation.modelSelection),
        sourceContinuationKey: JSON.stringify(conversation.continuationIdentity),
        sourceLatestTurnId: sourceLatestTurn?.id ?? null,
        sourceLatestTurnKey: JSON.stringify(sourceLatestTurn
          ? {
              id: sourceLatestTurn.id,
              modelSelection: sourceLatestTurn.modelSelection,
              continuationIdentity: sourceLatestTurn.continuationIdentity,
            }
          : null),
        destinationRevision:
          transition.selection.backendConfigurationRevision,
      });
      return;
    }
    const providerId = route.providerId
      ?? providerIdForHarness(route.selection.harnessId);
    await updateConversation({
      ...(providerId ? { providerId } : {}),
      modelSelection: transition.selection,
    });
  };
  const updatePromptStash = (
    update: (current: readonly PromptStashEntry[]) => PromptStashEntry[],
  ): boolean => {
    if (!promptStashEnabled) return false;
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
  const currentPromptStashRoute = {
    harnessId: conversation.modelSelection.harnessId,
    backendProfileId: conversation.modelSelection.backendProfileId,
    modelId: conversation.modelSelection.modelId,
    reasoningEffort: conversation.modelSelection.reasoningEffort,
    ...((selectedModel?.fastMode || selectedFastMode)
      && routeSupportsNativeFastModeIdentity(conversation.modelSelection)
      ? { fastMode: selectedFastMode }
      : {}),
  };
  const stashCurrentPrompt = (): void => {
    if (!message.trim() || attachments.length > 0) return;
    const persisted = updatePromptStash((current) => addPromptStashEntry(
      current,
      message,
      currentPromptStashRoute,
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
      const withoutRestored = advanceRecurringPrompt(current, entry.id);
      return message.trim()
        ? addPromptStashEntry(
            withoutRestored,
            message,
            currentPromptStashRoute,
          )
        : withoutRestored;
    });
    if (!persisted) return;
    updateMessage(entry.content);
    textareaRef.current?.focus();
  };
  const applyPromptPreset = async (preset: PromptPreset): Promise<boolean> => {
    const textarea = textareaRef.current;
    const { insertPromptPreset } = await import("../../utils/promptPresets");
    const insertion = insertPromptPreset(
      message,
      preset.body,
      textarea?.selectionStart ?? message.length,
      textarea?.selectionEnd ?? message.length,
    );
    if (!insertion) return false;
    updateMessage(insertion.value);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(
        insertion.selectionStart,
        insertion.selectionEnd,
      );
    });
    return true;
  };
  const insertSkill = (skill: (typeof skills)[number]): void => {
    const textarea = textareaRef.current;
    const insertion = insertComposerSkillToken(
      message,
      skill.name,
      textarea?.selectionStart ?? message.length,
      textarea?.selectionEnd ?? message.length,
    );
    if (insertion.inserted) updateMessage(insertion.value);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(
        insertion.selectionStart,
        insertion.selectionEnd,
      );
    });
  };
  const dismissPendingRoute = (): void => {
    setPendingRoute(null);
    setRouteCreationError(null);
    window.requestAnimationFrame(() => {
      composerRef.current
        ?.querySelector<HTMLButtonElement>(".selected-model-chip")
        ?.focus();
    });
  };
  const routeCreationBlockedReason = pendingRoute && (
    attachments.length > 0
    || Boolean(promptContext)
    || previewContextSelected
    || fileReferences.length > 0
    || contextPacketIds.length > 0
  )
    ? "Remove attachments, shared chat context, preview or diff context, and file references before transferring this text to a new chat."
    : null;

  return (
    <div className="composer-shell">
      <section
        ref={composerRef}
        className={clsx(
          "composer",
          (menu || slashMatch || commandSurface) && "has-open-menu",
        )}
        aria-label="Message composer"
        aria-busy={submissionPending || followUpPending || attachmentImporting || running || stopping || conversationUpdatePending}
        data-primary-action={primaryAction}
        data-disabled={disabled || conversationUpdatePending}
        onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
        onDrop={(event) => { if (!event.dataTransfer.files.length) return; event.preventDefault(); void importAttachments([...event.dataTransfer.files]); }}
      >
        {goal && (
          <Suspense fallback={null}>
            <ChatGoalControl
              {...goal}
              open={commandSurface === "goal"}
              onDismiss={dismissCommandSurface}
            />
          </Suspense>
        )}
        {commandSurface === "resume" && resumeOptions && resumeOptions.length > 0 && (
          <Suspense fallback={null}>
            <ChatResumeControl
              options={resumeOptions}
              open
              onDismiss={dismissCommandSurface}
              onResume={(resumeConversationId) => {
                onResumeConversation?.(resumeConversationId);
                onOpenResume();
              }}
            />
          </Suspense>
        )}
        {conversationContextHandoffEnabled && <ComposerConversationContextStrip controller={conversationContext} disabled={submissionPending || running} />}
        <ComposerInputZone
          routeReadiness={routeReadiness}
          routeRepairing={routeRepairing}
          disabled={disabled || conversationUpdatePending}
          onRunRouteRepair={runRouteRepair}
          promptContext={promptContext}
          onClearPromptContext={clearPromptContext}
          previewContextUrl={previewContextUrl}
          previewContextSelected={previewContextSelected}
          onTogglePreviewContext={togglePreviewContext}
          attachments={attachments} attachmentsDisabled={attachmentImporting} pendingAttachmentIds={pendingAttachmentIds}
          onRemoveAttachment={removeAttachment}
          pendingRoute={pendingRoute}
          creatingRouteConversation={creatingRouteConversation}
          routeCancelRef={routeCancelRef}
          canCreateRouteConversation={Boolean(
            onCreateConversationForSelection && !routeCreationBlockedReason,
          )}
          routeCreationBlockedReason={
            routeCreationBlockedReason ?? routeCreationError
          }
          onDismissPendingRoute={dismissPendingRoute}
          onCreateRouteConversation={() => {
            if (!onCreateConversationForSelection || !pendingRoute) return;
            setRouteCreationError(null);
            setCreatingRouteConversation(true);
            const sourceConversationId = conversation.id;
            const sourceEditorRevision = editorRevisionsRef.current.get(
              sourceConversationId,
            ) ?? 0;
            const prefillText = message.trim() ? message : undefined;
            void onCreateConversationForSelection(
              pendingRoute.selection,
              prefillText ? { prefillText } : undefined,
            ).then(
              () => {
                setPendingRoute(null);
                if (
                  prefillText
                  && conversationIdRef.current === sourceConversationId
                  && (editorRevisionsRef.current.get(sourceConversationId) ?? 0)
                    === sourceEditorRevision
                ) updateMessage("");
              },
              (error) => {
                if (!mountedRef.current) return;
                setRouteCreationError(
                  error instanceof Error
                    ? error.message
                    : "The new chat could not be created.",
                );
              },
            ).finally(() => {
              if (mountedRef.current) setCreatingRouteConversation(false);
            });
          }}
          textareaRef={textareaRef}
          message={message}
          onMessageChange={promptHistoryController.onMessageChange}
          onNavigatePromptHistory={promptHistoryController.navigate}
          onImportAttachments={importAttachments}
          onSubmit={submit}
          canQueue={canQueue}
          onQueue={() => void queueCurrentMessage()}
          running={running}
          submissionPending={submissionPending}
          followUpPending={followUpPending}
          typedMessageLimit={typedMessageLimit}
          messageFits={messageFits}
          mentionMatch={mentionMatch}
          mentionResults={mentionResults}
          onAddFileReference={addFileReference}
          {...skillCompletion}
          acceptSkill={insertSkill}
          dismissSkills={() => dismissMenu("context-change")}
          slashMatch={slashMatch}
          onCompactCommand={() => void compact({ kind: "compact" })}
          compactUnavailableReason={compactUnavailableReason}
          compactNotice={compactNotice}
          goalAvailable={Boolean(goal)}
          onOpenGoal={() => {
            updateMessage("");
            setCommandSurface("goal");
          }}
          onOpenResume={() => {
            updateMessage("");
            // Only the in-chat picker can offer a choice. With nothing
            // resumable to choose between, fall back to opening the terminal so
            // its own banner explains why.
            if (resumeOptions && resumeOptions.length > 0) setCommandSurface("resume");
            else onOpenResume();
          }}
          onUpdateConversation={updateConversation}
        />
        <ComposerToolbar
          actions={actions}
          disabled={disabled}
          running={running}
          attachmentCount={attachments.length}
          attachmentImporting={attachmentImporting}
          onChooseAttachments={chooseAttachments}
          {...composerConversationContextToolbarProps(conversationContext, contextSources.length, Boolean(onConversationContextCommand), conversationContextHandoffEnabled)}
          onRunAction={onRunAction}
          skills={skills}
          skillsCapability={skillsCapability}
          skillsLoading={skillsLoading}
          skillsError={skillsError}
          skillQuery={skillCompletion.skillQuery}
          skillListboxId={skillCompletion.skillListboxId}
          activeSkillId={skillCompletion.activeSkill?.id ?? null}
          onListSkills={onListSkills}
          onInsertSkill={insertSkill}
          promptPresets={promptPresets}
          promptPresetsEnabled={promptPresetsEnabled}
          promptStashEnabled={promptStashEnabled}
          currentPrompt={message}
          onApplyPromptPreset={applyPromptPreset}
          onPromptPresetCommand={onPromptPresetCommand}
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
            return promptStashRestoreBlockedReason(
              conversation.modelSelection,
              entry.route,
            );
          }}
          onStashPrompt={stashCurrentPrompt}
          onRestorePrompt={restoreStashedPrompt}
          onRemoveStashedPrompt={(entryId) =>
            updatePromptStash((current) =>
              removePromptStashEntry(current, entryId))}
          onSetPromptRecurrence={(entryId, recurrence) =>
            updatePromptStash((current) =>
              setPromptStashRecurrence(current, entryId, recurrence))}
          modelRoutes={modelRoutes}
          selectedModelRoute={selectedModelRoute}
          onChooseModelRoute={chooseModelRoute}
          selectedModel={selectedModel}
          selectedReasoning={selectedReasoning}
          reasoningLabel={reasoningLabel}
          selectedFastMode={selectedFastMode}
          onUpdateReasoningEffort={updateReasoningEffort}
          onUpdateFastMode={updateFastMode}
          conversation={conversation}
          checkoutBranch={checkoutBranch}
          showCheckoutContext={showCheckoutContext}
          newChatProjectPicker={newChatProjectPicker}
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
          primaryAction={primaryAction}
          canSendQueuedNow={!disabled && !sending && !attachmentImporting && (!running || followUpState === "ready")}
          queuedTurnId={(latestTurnSummary ?? latestTurn)?.id ?? null}
          queuedTurnStatus={(latestTurnSummary ?? latestTurn)?.status ?? null}
          queuedTurnAuthoritative={queuedTurnAuthoritative}
          onSendQueued={(content, queuedAttachments) => onSend(content, queuedAttachments, undefined)}
          onReleaseAttachment={onReleaseAttachment}
          onSubmit={submit}
          onStop={stop}
        />
        {conversationContextHandoffEnabled && <ComposerConversationContextDialog controller={conversationContext} targetConversationId={conversation.id} sources={contextSources} agentRequest={agentContextRequest} onCommand={onConversationContextCommand} />}
      </section>
    </div>
  );
});
