import {
  useEffect,
  useEffectEvent,
  useRef,
  type RefObject,
} from "react";

import {
  COMPOSER_STOP_RESTORE_EVENT,
  type ComposerStopRestoreDetail,
} from "../../utils/composerStopRestore";
import { isAgentTurnTerminalStatus } from "@shared/turn-lifecycle";
import type { AgentTurnStatus } from "@shared/turn-lifecycle";
import type { ComposerPromptHistoryEntry } from "./types";

interface PromptHistorySession {
  conversationId: string;
  signature: string;
  cursorId: string | null;
  scratch: string;
  edits: Map<string, string>;
}

interface PendingStopRestore {
  requestId: string;
  turnId: string;
  messageId: string;
  text: string;
  editorRevision: number;
}

interface ComposerPromptHistoryOptions {
  conversationId: string;
  entries: readonly ComposerPromptHistoryEntry[];
  latestTurn: { id: string; status: AgentTurnStatus } | null;
  message: string;
  onApplyMessage: (message: string) => void;
  readEditorRevision: () => number;
  canRestoreStoppedPrompt: () => boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

export type ComposerPromptHistoryDirection = "previous" | "next";

function historySignature(entries: readonly ComposerPromptHistoryEntry[]): string {
  return entries.map(({ id }) => id).join("\u0000");
}

function newSession(
  conversationId: string,
  signature: string,
  message: string,
): PromptHistorySession {
  return {
    conversationId,
    signature,
    cursorId: null,
    scratch: message,
    edits: new Map(),
  };
}

function reconcileSession(
  current: PromptHistorySession,
  conversationId: string,
  signature: string,
  message: string,
  entries: readonly ComposerPromptHistoryEntry[],
): PromptHistorySession {
  if (current.conversationId !== conversationId) {
    return newSession(conversationId, signature, message);
  }
  if (current.signature === signature) return current;
  current.signature = signature;
  if (
    current.cursorId
    && !entries.some(({ id }) => id === current.cursorId)
  ) current.cursorId = null;
  return current;
}

export function useComposerPromptHistory({
  conversationId,
  entries,
  latestTurn,
  message,
  onApplyMessage,
  readEditorRevision,
  canRestoreStoppedPrompt,
  textareaRef,
}: ComposerPromptHistoryOptions): {
  onMessageChange: (message: string) => void;
  navigate: (direction: ComposerPromptHistoryDirection) => boolean;
  replaceMessage: (message: string) => void;
  reset: (scratch?: string) => void;
} {
  const signature = historySignature(entries);
  const sessionRef = useRef<PromptHistorySession>(
    newSession(conversationId, signature, message),
  );
  const pendingStopRestoreRef = useRef<PendingStopRestore | null>(null);
  const settlementInputsRef = useRef({
    conversationId,
    signature,
    entries,
    latestTurn,
    message,
    onApplyMessage,
    readEditorRevision,
    canRestoreStoppedPrompt,
    textareaRef,
  });
  settlementInputsRef.current = {
    conversationId,
    signature,
    entries,
    latestTurn,
    message,
    onApplyMessage,
    readEditorRevision,
    canRestoreStoppedPrompt,
    textareaRef,
  };

  const currentSession = (): PromptHistorySession => {
    sessionRef.current = reconcileSession(
      sessionRef.current,
      conversationId,
      signature,
      message,
      entries,
    );
    return sessionRef.current;
  };

  const changeMessage = (next: string): void => {
    const session = currentSession();
    if (session.cursorId === null) {
      session.scratch = next;
    } else {
      const entry = entries.find(({ id }) => id === session.cursorId);
      if (entry) session.edits.set(entry.id, next);
    }
    onApplyMessage(next);
  };

  const reset = (scratch = message): void => {
    sessionRef.current = newSession(conversationId, signature, scratch);
  };

  const replaceMessage = (next: string): void => {
    reset(next);
    onApplyMessage(next);
  };

  const focusAt = (position: number): void => {
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(position, position);
    });
  };

  const navigate = (direction: ComposerPromptHistoryDirection): boolean => {
    const session = currentSession();
    const cursorIndex = session.cursorId === null
      ? -1
      : entries.findIndex(({ id }) => id === session.cursorId);
    if (direction === "previous") {
      if (entries.length === 0 || cursorIndex === 0) return false;
      if (session.cursorId === null) session.scratch = message;
      else {
        const entry = entries[cursorIndex];
        if (entry) session.edits.set(entry.id, message);
      }
      const nextIndex = session.cursorId === null
        ? entries.length - 1
        : cursorIndex - 1;
      const entry = entries[nextIndex]!;
      session.cursorId = entry.id;
      const next = session.edits.get(entry.id) ?? entry.content;
      onApplyMessage(next);
      focusAt(next.length);
      return true;
    }

    if (session.cursorId === null || cursorIndex < 0) return false;
    const currentEntry = entries[cursorIndex];
    if (currentEntry) session.edits.set(currentEntry.id, message);
    if (cursorIndex === entries.length - 1) {
      session.cursorId = null;
      onApplyMessage(session.scratch);
      focusAt(session.scratch.length);
      return true;
    }
    const entry = entries[cursorIndex + 1]!;
    session.cursorId = entry.id;
    const next = session.edits.get(entry.id) ?? entry.content;
    onApplyMessage(next);
    focusAt(next.length);
    return true;
  };

  const handleStopRestore = useEffectEvent((
    detail: ComposerStopRestoreDetail,
  ): void => {
    if (detail.conversationId !== conversationId) return;
    if (detail.phase === "start") {
      pendingStopRestoreRef.current = canRestoreStoppedPrompt()
        ? {
            requestId: detail.requestId,
            turnId: detail.turnId,
            messageId: detail.messageId,
            text: detail.text,
            editorRevision: readEditorRevision(),
          }
        : null;
      return;
    }

    if (
      detail.phase === "failed"
      && pendingStopRestoreRef.current?.requestId === detail.requestId
    ) pendingStopRestoreRef.current = null;
  });

  useEffect(() => {
    const {
      conversationId: currentConversationId,
      signature: currentSignature,
      entries: currentEntries,
      latestTurn: currentLatestTurn,
      message: currentMessage,
      onApplyMessage: applyMessage,
      readEditorRevision: currentEditorRevision,
      canRestoreStoppedPrompt: canRestore,
      textareaRef: currentTextareaRef,
    } = settlementInputsRef.current;
    const pending = pendingStopRestoreRef.current;
    if (!pending || currentLatestTurn?.id !== pending.turnId) return;
    if (currentLatestTurn.status !== "cancelled") {
      if (isAgentTurnTerminalStatus(currentLatestTurn.status)) {
        pendingStopRestoreRef.current = null;
      }
      return;
    }
    pendingStopRestoreRef.current = null;
    if (
      pending.editorRevision !== currentEditorRevision()
      || !canRestore()
    ) return;

    sessionRef.current = reconcileSession(
      sessionRef.current,
      currentConversationId,
      currentSignature,
      currentMessage,
      currentEntries,
    );
    const session = sessionRef.current;
    const restored = currentEntries.some(({ id }) => id === pending.messageId);
    session.scratch = currentMessage;
    session.cursorId = restored ? pending.messageId : null;
    if (restored) session.edits.set(pending.messageId, pending.text);
    applyMessage(pending.text);
    window.requestAnimationFrame(() => {
      const textarea = currentTextareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(pending.text.length, pending.text.length);
    });
  }, [latestTurn?.id, latestTurn?.status]);

  useEffect(() => {
    pendingStopRestoreRef.current = null;
  }, [conversationId]);

  useEffect(() => {
    const handleEvent = (event: Event): void => {
      const detail = (event as CustomEvent<ComposerStopRestoreDetail>).detail;
      if (detail) handleStopRestore(detail);
    };
    window.addEventListener(COMPOSER_STOP_RESTORE_EVENT, handleEvent);
    return () => window.removeEventListener(
      COMPOSER_STOP_RESTORE_EVENT,
      handleEvent,
    );
  }, []);

  return { onMessageChange: changeMessage, navigate, replaceMessage, reset };
}
