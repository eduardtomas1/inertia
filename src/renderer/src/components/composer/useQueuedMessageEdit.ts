import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import type { ChatAttachment, ProviderInfo } from "@shared/contracts";
import type { ModelSelection } from "@shared/model-routing";
import type { QueuedMessage } from "@shared/queued-messages";
import { keepComposerDraftAttachments } from "../../utils/composerDraftAttachments";
import { persistComposerDraft } from "../../utils/composerDraftPersistence";
import {
  editRuntimeQueuedMessage,
  type QueueCommandRunner,
  type QueuedMessageEdit,
} from "./runtimeQueueClient";
import { announceRuntimeQueueChanged } from "./runtimeQueueEvents";

export const QUEUE_EDIT_PENDING_REQUEST_BLOCKED =
  "Answer or resolve the pending request before editing a queued message";
export const QUEUE_EDIT_BUSY = "Wait for the current message to finish";

interface StashedComposerDraft {
  readonly message: string;
  readonly attachments: ChatAttachment[];
  readonly fileReferences: string[];
  readonly promptContext: string | null;
  readonly previewContextSelected: boolean;
  readonly contextPacketIds: readonly string[];
  readonly calledAgentId: string | null;
}

interface ActiveEditSession {
  readonly conversationId: string;
  readonly entry: QueuedMessage;
  readonly originalAttachmentIds: ReadonlySet<string>;
}

export function formatQueueModelLabel(
  selection: ModelSelection | null | undefined,
  providers?: readonly ProviderInfo[],
): string | null {
  if (!selection) return null;
  const provider = providers?.find((item) => item.models.some(({ id }) => id === selection.modelId));
  const model = provider?.models.find(({ id }) => id === selection.modelId);
  return model?.label ?? selection.modelId;
}

function attachmentsMatch(
  left: readonly ChatAttachment[],
  right: readonly QueuedMessage["attachments"][number][],
): boolean {
  return left.length === right.length && left.every((item, index) => item.id === right[index]?.id);
}

function isStashedDraftEmpty(draft: StashedComposerDraft | null): boolean {
  if (!draft) return true;
  return draft.message.trim().length === 0
    && draft.attachments.length === 0
    && draft.fileReferences.length === 0
    && draft.promptContext === null
    && !draft.previewContextSelected
    && draft.contextPacketIds.length === 0
    && draft.calledAgentId === null;
}

export interface UseQueuedMessageEditOptions {
  conversationId: string;
  providers?: readonly ProviderInfo[];
  message: string;
  attachments: readonly ChatAttachment[];
  fileReferences: readonly string[];
  promptContext?: string | null;
  previewContextSelected: boolean;
  contextPacketIds: readonly string[];
  calledAgentId?: string | null;
  attachmentFallback: string;
  hasPendingQuestionOrApproval: boolean;
  disabled: boolean;
  submitting: boolean;
  sending: boolean;
  conversationUpdatePending: boolean;
  onQueueCommand?: QueueCommandRunner;
  refs: {
    attachmentsRef: MutableRefObject<ChatAttachment[]>;
    draftValueRef: MutableRefObject<string>;
    isEditingRef?: MutableRefObject<boolean>;
    queueOwnedAttachmentIdsRef: MutableRefObject<Set<string>>;
    releaseAttachmentRef: MutableRefObject<(attachmentId: string) => Promise<void>>;
    selectedPreviewUrlRef: MutableRefObject<string | null>;
    textareaRef: RefObject<HTMLTextAreaElement | null>;
  };
  setMessage: Dispatch<SetStateAction<string>>;
  setAttachments: Dispatch<SetStateAction<ChatAttachment[]>>;
  setFileReferences: Dispatch<SetStateAction<string[]>>;
  setPreviewContextSelected: Dispatch<SetStateAction<boolean>>;
  setAttachmentError: Dispatch<SetStateAction<string | null>>;
  flushDraftPersistence: () => void;
  markEditorChanged: (conversationId?: string) => void;
  visiblePreviewContextUrl: string | null;
}

export function useQueuedMessageEdit({
  conversationId,
  providers,
  message,
  attachments,
  fileReferences,
  promptContext = null,
  previewContextSelected,
  contextPacketIds,
  calledAgentId = null,
  attachmentFallback,
  hasPendingQuestionOrApproval,
  disabled,
  submitting,
  sending,
  conversationUpdatePending,
  onQueueCommand,
  refs,
  setMessage,
  setAttachments,
  setFileReferences,
  setPreviewContextSelected,
  setAttachmentError,
  flushDraftPersistence,
  markEditorChanged,
  visiblePreviewContextUrl,
}: UseQueuedMessageEditOptions) {
  const [session, setSession] = useState<ActiveEditSession | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sessionRef = useRef<ActiveEditSession | null>(null);
  sessionRef.current = session;
  const fallbackEditingRef = useRef(false);
  const refsRef = useRef(refs);
  refsRef.current = refs;
  const syncEditingFlag = useCallback((editing: boolean): void => {
    const flag = refsRef.current.isEditingRef ?? fallbackEditingRef;
    flag.current = editing;
  }, []);
  syncEditingFlag(session !== null);

  const stashedDraftRef = useRef<StashedComposerDraft | null>(null);
  const stagedAttachmentIdsRef = useRef(new Set<string>());
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const unsavedEditTextRef = useRef(new Map<string, { editRevision: number; text: string }>());
  const snapshotInputsRef = useRef({
    fileReferences,
    promptContext,
    previewContextSelected,
    contextPacketIds,
    calledAgentId,
    visiblePreviewContextUrl,
  });
  snapshotInputsRef.current = {
    fileReferences,
    promptContext,
    previewContextSelected,
    contextPacketIds,
    calledAgentId,
    visiblePreviewContextUrl,
  };

  const blockedReason = hasPendingQuestionOrApproval
    ? QUEUE_EDIT_PENDING_REQUEST_BLOCKED
    : disabled || submitting || sending || conversationUpdatePending || saving
      ? QUEUE_EDIT_BUSY
      : null;

  const trimmed = message.trim();
  const isCleared = session !== null && trimmed.length === 0 && attachments.length === 0;
  const dirty = session !== null && (
    message !== session.entry.content
    || !attachmentsMatch(attachments, session.entry.attachments)
  );
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Track newly staged uploads added through any attachment entry point while editing.
  useEffect(() => {
    if (!session) return;
    for (const attachment of attachments) {
      if (!session.originalAttachmentIds.has(attachment.id)) {
        stagedAttachmentIdsRef.current.add(attachment.id);
      }
    }
  }, [attachments, session]);

  const releaseStagedUploads = useCallback((): void => {
    const staged = [...stagedAttachmentIdsRef.current];
    stagedAttachmentIdsRef.current.clear();
    const release = refsRef.current.releaseAttachmentRef.current;
    for (const id of staged) {
      void release(id);
    }
  }, []);

  // Clean up only on conversation switch or unmount: release newly staged uploads,
  // never release server-owned originals, and preserve stashed draft attachments.
  useEffect(() => {
    const ownerId = conversationId;
    const unsavedMap = unsavedEditTextRef.current;
    const cleanup = (): void => {
      const currentRefs = refsRef.current;
      const active = sessionRef.current;
      const stashed = stashedDraftRef.current;
      const owned = currentRefs.queueOwnedAttachmentIdsRef.current;
      const release = currentRefs.releaseAttachmentRef.current;
      if (active) {
        for (const id of active.originalAttachmentIds) owned.delete(id);
      }
      if (stashed) {
        for (const { id } of stashed.attachments) owned.delete(id);
        keepComposerDraftAttachments(ownerId, stashed.attachments, (id) => release(id));
        stashedDraftRef.current = null;
      }
      releaseStagedUploads();
      sessionRef.current = null;
      syncEditingFlag(false);
      triggerRef.current = null;
      unsavedMap.clear();
      setSession(null);
      setSaving(false);
      setError(null);
      setNotice(null);
    };
    return cleanup;
  }, [conversationId, releaseStagedUploads, syncEditingFlag]);

  const restoreStashedDraft = useCallback((focusTrigger: boolean): void => {
    const currentRefs = refsRef.current;
    const active = sessionRef.current;
    const stashed = stashedDraftRef.current;
    const owned = currentRefs.queueOwnedAttachmentIdsRef.current;
    if (active) {
      for (const id of active.originalAttachmentIds) owned.delete(id);
    }
    stashedDraftRef.current = null;
    if (stashed) {
      for (const { id } of stashed.attachments) owned.delete(id);
      currentRefs.draftValueRef.current = stashed.message;
      setMessage(stashed.message);
      currentRefs.attachmentsRef.current = [...stashed.attachments];
      setAttachments([...stashed.attachments]);
      setFileReferences([...stashed.fileReferences]);
      currentRefs.selectedPreviewUrlRef.current = stashed.previewContextSelected
        ? snapshotInputsRef.current.visiblePreviewContextUrl
        : null;
      setPreviewContextSelected(stashed.previewContextSelected);
    }
    sessionRef.current = null;
    syncEditingFlag(false);
    setSession(null);
    setSaving(false);
    setError(null);
    const trigger = triggerRef.current;
    triggerRef.current = null;
    window.requestAnimationFrame(() => {
      if (focusTrigger && trigger?.isConnected) trigger.focus();
      else refsRef.current.textareaRef.current?.focus();
    });
  }, [setAttachments, setFileReferences, setMessage, setPreviewContextSelected, syncEditingFlag]);

  const startEdit = useCallback((
    entry: QueuedMessage,
    trigger?: HTMLButtonElement | null,
  ): void => {
    if (blockedReason !== null || entry.conversationId !== conversationId) return;
    const currentRefs = refsRef.current;
    const previous = sessionRef.current;
    const owned = currentRefs.queueOwnedAttachmentIdsRef.current;
    if (previous) {
      if (previous.entry.id === entry.id) {
        currentRefs.textareaRef.current?.focus();
        return;
      }
      for (const id of previous.originalAttachmentIds) owned.delete(id);
      releaseStagedUploads();
    } else {
      flushDraftPersistence();
      const snap = snapshotInputsRef.current;
      const stashed: StashedComposerDraft = {
        message: currentRefs.draftValueRef.current,
        attachments: [...currentRefs.attachmentsRef.current],
        fileReferences: [...snap.fileReferences],
        promptContext: snap.promptContext ?? null,
        previewContextSelected: snap.previewContextSelected,
        contextPacketIds: [...snap.contextPacketIds],
        calledAgentId: snap.calledAgentId ?? null,
      };
      stashedDraftRef.current = stashed;
      for (const { id } of stashed.attachments) owned.add(id);
    }
    const originalAttachmentIds = new Set(entry.attachments.map(({ id }) => id));
    for (const id of originalAttachmentIds) owned.add(id);
    stagedAttachmentIdsRef.current.clear();
    triggerRef.current = trigger ?? null;
    const retained = unsavedEditTextRef.current.get(entry.id);
    const entryRevision = entry.editRevision ?? 0;
    const initialContent = retained && retained.editRevision === entryRevision
      ? retained.text
      : entry.content;
    const nextSession: ActiveEditSession = {
      conversationId,
      entry,
      originalAttachmentIds,
    };
    sessionRef.current = nextSession;
    syncEditingFlag(true);
    currentRefs.draftValueRef.current = initialContent;
    setMessage(initialContent);
    const clonedAttachments: ChatAttachment[] = entry.attachments.map((attachment) => ({
      ...attachment,
    }));
    currentRefs.attachmentsRef.current = clonedAttachments;
    setAttachments(clonedAttachments);
    setAttachmentError(null);
    setError(null);
    setNotice(null);
    setSession(nextSession);
    window.requestAnimationFrame(() => refsRef.current.textareaRef.current?.focus());
  }, [
    blockedReason,
    conversationId,
    flushDraftPersistence,
    releaseStagedUploads,
    setAttachmentError,
    setAttachments,
    setMessage,
    syncEditingFlag,
  ]);

  const handleRemoveAttachment = useCallback((attachment: ChatAttachment): boolean => {
    const active = sessionRef.current;
    if (!active) return false;
    const currentRefs = refsRef.current;
    if (!currentRefs.attachmentsRef.current.some(({ id }) => id === attachment.id)) return true;
    markEditorChanged(conversationId);
    setAttachmentError(null);
    const next = currentRefs.attachmentsRef.current.filter(({ id }) => id !== attachment.id);
    currentRefs.attachmentsRef.current = next;
    setAttachments(next);
    if (stagedAttachmentIdsRef.current.has(attachment.id)) {
      stagedAttachmentIdsRef.current.delete(attachment.id);
      void currentRefs.releaseAttachmentRef.current(attachment.id);
    }
    return true;
  }, [conversationId, markEditorChanged, setAttachmentError, setAttachments]);

  const cancel = useCallback((): void => {
    const active = sessionRef.current;
    if (!active || saving) return;
    if (dirtyRef.current && refsRef.current.draftValueRef.current !== active.entry.content) {
      unsavedEditTextRef.current.set(active.entry.id, {
        editRevision: active.entry.editRevision ?? 0,
        text: refsRef.current.draftValueRef.current,
      });
    } else {
      unsavedEditTextRef.current.delete(active.entry.id);
    }
    releaseStagedUploads();
    restoreStashedDraft(true);
  }, [releaseStagedUploads, restoreStashedDraft, saving]);

  const save = useCallback(async (): Promise<void> => {
    const active = sessionRef.current;
    if (!active || saving || !onQueueCommand || !dirty || isCleared) return;
    setSaving(true);
    setError(null);
    const currentRefs = refsRef.current;
    const currentAttachments = currentRefs.attachmentsRef.current;
    const stagedIds = [...stagedAttachmentIdsRef.current].filter((id) =>
      currentAttachments.some((attachment) => attachment.id === id));
    const contentToSave = currentRefs.draftValueRef.current.trim() || attachmentFallback;
    try {
      await editRuntimeQueuedMessage(onQueueCommand, {
        conversationId,
        id: active.entry.id,
        expectedRevision: active.entry.editRevision ?? 0,
        content: contentToSave,
        attachments: currentAttachments,
        ...(active.entry.modelSelection !== undefined
          ? { modelSelection: active.entry.modelSelection }
          : {}),
        stagedAttachmentIds: stagedIds,
      });
      if (sessionRef.current?.entry.id !== active.entry.id) return;
      unsavedEditTextRef.current.delete(active.entry.id);
      stagedAttachmentIdsRef.current.clear();
      restoreStashedDraft(true);
    } catch (failure) {
      if (sessionRef.current?.entry.id !== active.entry.id) return;
      setError(failure instanceof Error ? failure.message : "The queued message could not be saved.");
      setSaving(false);
    }
  }, [
    attachmentFallback,
    conversationId,
    dirty,
    isCleared,
    onQueueCommand,
    restoreStashedDraft,
    saving,
  ]);

  const discard = useCallback(async (): Promise<void> => {
    const active = sessionRef.current;
    if (!active || saving || !onQueueCommand || !isCleared) return;
    setSaving(true);
    setError(null);
    try {
      await onQueueCommand({
        type: "message.queue.remove",
        payload: { conversationId, id: active.entry.id },
      });
      announceRuntimeQueueChanged(conversationId);
      if (sessionRef.current?.entry.id !== active.entry.id) return;
      unsavedEditTextRef.current.delete(active.entry.id);
      releaseStagedUploads();
      restoreStashedDraft(false);
    } catch (failure) {
      if (sessionRef.current?.entry.id !== active.entry.id) return;
      setError(failure instanceof Error ? failure.message : "The queued message could not be discarded.");
      setSaving(false);
    }
  }, [
    conversationId,
    isCleared,
    onQueueCommand,
    releaseStagedUploads,
    restoreStashedDraft,
    saving,
  ]);

  const onEntriesObserved = useCallback((entries: readonly QueuedMessage[]): void => {
    const active = sessionRef.current;
    if (!active) return;
    const match = entries.find(({ id }) => id === active.entry.id);
    if (match && (match.state === "waiting" || match.state === "blocked")) return;
    unsavedEditTextRef.current.delete(active.entry.id);
    const currentRefs = refsRef.current;
    const hasUnsaved = dirtyRef.current;
    const stashed = stashedDraftRef.current;
    const owned = currentRefs.queueOwnedAttachmentIdsRef.current;
    for (const id of active.originalAttachmentIds) owned.delete(id);
    if (hasUnsaved && isStashedDraftEmpty(stashed)) {
      if (stashed) {
        for (const { id } of stashed.attachments) owned.delete(id);
      }
      stashedDraftRef.current = null;
      const stagedSet = stagedAttachmentIdsRef.current;
      const keptStaged = currentRefs.attachmentsRef.current.filter(({ id }) => stagedSet.has(id));
      stagedAttachmentIdsRef.current.clear();
      currentRefs.attachmentsRef.current = keptStaged;
      setAttachments(keptStaged);
      persistComposerDraft(conversationId, currentRefs.draftValueRef.current);
      sessionRef.current = null;
      syncEditingFlag(false);
      triggerRef.current = null;
      setSession(null);
      setSaving(false);
      setError(null);
      setNotice("That queued message started sending or was removed. Your unsaved edits were moved to the draft.");
      return;
    }
    releaseStagedUploads();
    restoreStashedDraft(false);
    setNotice(hasUnsaved
      ? "That queued message started sending or was removed. Your existing draft was kept."
      : "That queued message started sending or was removed.");
  }, [conversationId, releaseStagedUploads, restoreStashedDraft, setAttachments, syncEditingFlag]);

  const modelLabel = useMemo(
    () => formatQueueModelLabel(session?.entry.modelSelection, providers),
    [providers, session?.entry.modelSelection],
  );

  const queueEdit = useMemo<QueuedMessageEdit>(() => ({
    blockedReason,
    editingId: session?.entry.id ?? null,
    notice,
    session: session
      ? {
          entry: session.entry,
          dirty,
          isCleared,
          saving,
          error,
          modelLabel,
          onSave: save,
          onDiscard: discard,
          onCancel: cancel,
        }
      : null,
    onStartEdit: startEdit,
    onEntriesObserved,
  }), [
    blockedReason,
    cancel,
    dirty,
    discard,
    error,
    isCleared,
    modelLabel,
    notice,
    onEntriesObserved,
    save,
    saving,
    session,
    startEdit,
  ]);

  return {
    isEditing: session !== null,
    saving,
    notice,
    queueEdit,
    handleRemoveAttachment,
    save,
    discard,
    cancel,
  };
}
