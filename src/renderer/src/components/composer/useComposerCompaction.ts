import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";

import {
  GEMINI_EXPLICIT_COMPACTION_UNAVAILABLE_REASON,
  type ProviderId,
} from "../../../../shared/provider";
import type { CompactComposerCommand } from "../../utils/composerCommands";
import { clearPersistedComposerDraft } from "../../utils/composerDraftPersistence";

export interface ComposerCompactNotice {
  kind: "working" | "success" | "error";
  message: string;
}

export function useComposerCompaction(options: {
  conversationId: string;
  providerId: ProviderId;
  message: string;
  canSend: boolean;
  running: boolean;
  blocked: boolean;
  flushDraftPersistence: () => void;
  editorRevisions: MutableRefObject<Map<string, number>>;
  conversationIdRef: MutableRefObject<string>;
  mountedRef: MutableRefObject<boolean>;
  submittingRef: MutableRefObject<boolean>;
  draftValueRef: MutableRefObject<string>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  clearMessage: () => void;
  setSubmitting: Dispatch<SetStateAction<boolean>>;
  onCompact: (instruction?: string) => Promise<{ message: string }>;
}): {
  compactNotice: ComposerCompactNotice | null;
  compactUnavailableReason: string | null;
  clearCompactNotice: () => void;
  compact: (command: CompactComposerCommand) => Promise<void>;
} {
  const {
    conversationId,
    providerId,
    message,
    canSend,
    running,
    blocked,
    flushDraftPersistence,
    editorRevisions,
    conversationIdRef,
    mountedRef,
    submittingRef,
    draftValueRef,
    textareaRef,
    clearMessage,
    setSubmitting,
    onCompact,
  } = options;
  const [compactNotices, setCompactNotices] = useState<Readonly<
    Record<string, ComposerCompactNotice>
  >>({});
  const operationSequence = useRef(0);
  const activeOperations = useRef(new Map<string, number>());
  const compactUnavailableReason = providerId === "gemini"
    ? GEMINI_EXPLICIT_COMPACTION_UNAVAILABLE_REASON
    : null;
  const compactNotice = compactNotices[conversationId] ?? null;
  const clearCompactNotice = useCallback(() => {
    setCompactNotices((current) => {
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
  }, [conversationId]);
  const setCompactNotice = (
    conversationId: string,
    notice: ComposerCompactNotice,
  ): void => {
    setCompactNotices((current) => ({
      ...current,
      [conversationId]: notice,
    }));
  };
  const compact = async (command: CompactComposerCommand): Promise<void> => {
    const ownerId = conversationId;
    if (
      submittingRef.current
      || activeOperations.current.has(ownerId)
    ) return;
    if (compactUnavailableReason) {
      setCompactNotice(conversationId, {
        kind: "error",
        message: compactUnavailableReason,
      });
      return;
    }
    if (running) {
      setCompactNotice(conversationId, {
        kind: "error",
        message: "Wait for the current provider turn to finish.",
      });
      return;
    }
    if (!canSend) {
      setCompactNotice(conversationId, {
        kind: "error",
        message: "Provider not ready for compaction.",
      });
      return;
    }
    if (blocked) {
      setCompactNotice(conversationId, {
        kind: "error",
        message: "Remove attachments or context before compacting.",
      });
      return;
    }
    flushDraftPersistence();
    const submittedDraft = message;
    const submittedRevision = editorRevisions.current.get(ownerId) ?? 0;
    operationSequence.current += 1;
    const operationId = operationSequence.current;
    activeOperations.current.set(ownerId, operationId);
    submittingRef.current = true;
    setSubmitting(true);
    setCompactNotice(ownerId, {
      kind: "working",
      message: "Compacting…",
    });
    try {
      const result = await onCompact(command.instruction);
      if (
        !mountedRef.current
        || activeOperations.current.get(ownerId) !== operationId
      ) return;
      const ownsVisibleComposer = conversationIdRef.current === ownerId;
      if ((editorRevisions.current.get(ownerId) ?? 0) === submittedRevision) {
        clearPersistedComposerDraft(ownerId, submittedDraft);
        if (ownsVisibleComposer) {
          draftValueRef.current = "";
          clearMessage();
        }
      }
      setCompactNotice(ownerId, { kind: "success", message: result.message });
      if (ownsVisibleComposer) textareaRef.current?.focus();
    } catch (error) {
      if (
        mountedRef.current
        && activeOperations.current.get(ownerId) === operationId
      ) {
        setCompactNotice(ownerId, {
          kind: "error",
          message: error instanceof Error
            ? error.message
            : "Context compaction failed.",
        });
        if (conversationIdRef.current === ownerId) {
          textareaRef.current?.focus();
        }
      }
    } finally {
      if (activeOperations.current.get(ownerId) === operationId) {
        activeOperations.current.delete(ownerId);
        if (
          mountedRef.current
          && conversationIdRef.current === ownerId
        ) {
          submittingRef.current = false;
          setSubmitting(false);
        }
      }
    }
  };
  return { compactNotice, clearCompactNotice, compact, compactUnavailableReason };
}
