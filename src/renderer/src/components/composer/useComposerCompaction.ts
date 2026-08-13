import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";

import type { CompactComposerCommand } from "../../utils/composerCommands";

export interface ComposerCompactNotice {
  kind: "working" | "success" | "error";
  message: string;
}

export function useComposerCompaction(options: {
  conversationId: string;
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
  setMessage: Dispatch<SetStateAction<string>>;
  setSubmitting: Dispatch<SetStateAction<boolean>>;
  onCompact: (instruction?: string) => Promise<{ message: string }>;
}): {
  compactNotice: ComposerCompactNotice | null;
  clearCompactNotice: () => void;
  compact: (command: CompactComposerCommand) => Promise<void>;
} {
  const [compactNotices, setCompactNotices] = useState<Readonly<
    Record<string, ComposerCompactNotice>
  >>({});
  const operationSequence = useRef(0);
  const activeOperations = useRef(new Map<string, number>());
  const compactNotice = compactNotices[options.conversationId] ?? null;
  const clearCompactNotice = useCallback(() => {
    setCompactNotices((current) => {
      if (!(options.conversationId in current)) return current;
      const next = { ...current };
      delete next[options.conversationId];
      return next;
    });
  }, [options.conversationId]);
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
    const ownerId = options.conversationId;
    if (
      options.submittingRef.current
      || activeOperations.current.has(ownerId)
    ) return;
    if (options.running) {
      setCompactNotice(options.conversationId, {
        kind: "error",
        message: "Wait for the current provider turn to finish before compacting this chat.",
      });
      return;
    }
    if (!options.canSend) {
      setCompactNotice(options.conversationId, {
        kind: "error",
        message: "This chat's provider route is not ready for context compaction.",
      });
      return;
    }
    if (options.blocked) {
      setCompactNotice(options.conversationId, {
        kind: "error",
        message: "Remove attachments, preview or diff context, file references, and selected skills before compacting.",
      });
      return;
    }
    options.flushDraftPersistence();
    const submittedDraft = options.message;
    const submittedRevision = options.editorRevisions.current.get(ownerId) ?? 0;
    operationSequence.current += 1;
    const operationId = operationSequence.current;
    activeOperations.current.set(ownerId, operationId);
    options.submittingRef.current = true;
    options.setSubmitting(true);
    setCompactNotice(ownerId, {
      kind: "working",
      message: "Compacting provider context…",
    });
    try {
      const result = await options.onCompact(command.instruction);
      if (
        !options.mountedRef.current
        || activeOperations.current.get(ownerId) !== operationId
      ) return;
      const ownsVisibleComposer = options.conversationIdRef.current === ownerId;
      if ((options.editorRevisions.current.get(ownerId) ?? 0) === submittedRevision) {
        try {
          const key = `inertia:draft:${ownerId}`;
          if (window.localStorage.getItem(key) === submittedDraft) {
            window.localStorage.removeItem(key);
          }
        } catch {
          // The completed in-memory command can still settle without storage.
        }
        if (ownsVisibleComposer) {
          options.draftValueRef.current = "";
          options.setMessage("");
        }
      }
      setCompactNotice(ownerId, { kind: "success", message: result.message });
      if (ownsVisibleComposer) options.textareaRef.current?.focus();
    } catch (error) {
      if (
        options.mountedRef.current
        && activeOperations.current.get(ownerId) === operationId
      ) {
        setCompactNotice(ownerId, {
          kind: "error",
          message: error instanceof Error
            ? error.message
            : "The provider could not compact this chat.",
        });
        if (options.conversationIdRef.current === ownerId) {
          options.textareaRef.current?.focus();
        }
      }
    } finally {
      if (activeOperations.current.get(ownerId) === operationId) {
        activeOperations.current.delete(ownerId);
        if (
          options.mountedRef.current
          && options.conversationIdRef.current === ownerId
        ) {
          options.submittingRef.current = false;
          options.setSubmitting(false);
        }
      }
    }
  };
  return { compactNotice, clearCompactNotice, compact };
}
