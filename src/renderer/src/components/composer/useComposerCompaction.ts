import {
  useCallback,
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
  const [compactNoticeState, setCompactNoticeState] = useState<{
    conversationId: string;
    notice: ComposerCompactNotice;
  } | null>(null);
  const compactNotice = compactNoticeState?.conversationId === options.conversationId
    ? compactNoticeState.notice
    : null;
  const clearCompactNotice = useCallback(() => setCompactNoticeState(null), []);
  const setCompactNotice = (notice: ComposerCompactNotice): void => {
    setCompactNoticeState({
      conversationId: options.conversationId,
      notice,
    });
  };
  const compact = async (command: CompactComposerCommand): Promise<void> => {
    if (options.submittingRef.current) return;
    if (options.running) {
      setCompactNotice({
        kind: "error",
        message: "Wait for the current provider turn to finish before compacting this chat.",
      });
      return;
    }
    if (!options.canSend) {
      setCompactNotice({
        kind: "error",
        message: "This chat's provider route is not ready for context compaction.",
      });
      return;
    }
    if (options.blocked) {
      setCompactNotice({
        kind: "error",
        message: "Remove attachments, preview or diff context, file references, and selected skills before compacting.",
      });
      return;
    }
    options.flushDraftPersistence();
    const ownerId = options.conversationId;
    const submittedDraft = options.message;
    const submittedRevision = options.editorRevisions.current.get(ownerId) ?? 0;
    options.submittingRef.current = true;
    options.setSubmitting(true);
    setCompactNotice({ kind: "working", message: "Compacting provider context…" });
    try {
      const result = await options.onCompact(command.instruction);
      if (!options.mountedRef.current || options.conversationIdRef.current !== ownerId) return;
      if ((options.editorRevisions.current.get(ownerId) ?? 0) === submittedRevision) {
        try {
          const key = `inertia:draft:${ownerId}`;
          if (window.localStorage.getItem(key) === submittedDraft) {
            window.localStorage.removeItem(key);
          }
        } catch {
          // The completed in-memory command can still settle without storage.
        }
        options.draftValueRef.current = "";
        options.setMessage("");
      }
      setCompactNotice({ kind: "success", message: result.message });
      options.textareaRef.current?.focus();
    } catch (error) {
      if (options.mountedRef.current && options.conversationIdRef.current === ownerId) {
        setCompactNotice({
          kind: "error",
          message: error instanceof Error
            ? error.message
            : "The provider could not compact this chat.",
        });
        options.textareaRef.current?.focus();
      }
    } finally {
      if (options.mountedRef.current && options.conversationIdRef.current === ownerId) {
        options.submittingRef.current = false;
        options.setSubmitting(false);
      }
    }
  };
  return { compactNotice, clearCompactNotice, compact };
}
