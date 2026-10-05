import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import { clearPersistedComposerDraft } from "../../utils/composerDraftPersistence";
import type { ComposerProps, PendingModelRoute } from "./types";

interface ComposerRouteConversationOptions {
  pendingRoute: PendingModelRoute | null;
  message: string;
  conversationId: string;
  onCreateConversationForSelection: ComposerProps["onCreateConversationForSelection"];
  conversationIdRef: MutableRefObject<string>;
  mountedRef: MutableRefObject<boolean>;
  editorRevisionsRef: MutableRefObject<Map<string, number>>;
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>;
  clearMessage: () => void;
  setPendingRoute: Dispatch<SetStateAction<PendingModelRoute | null>>;
  setRouteCreationError: Dispatch<SetStateAction<string | null>>;
  setCreatingRouteConversation: Dispatch<SetStateAction<boolean>>;
}

export function useComposerRouteConversation(): (
  options: ComposerRouteConversationOptions,
) => void {
  const focusFrameRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
  }, []);
  return useCallback(({
    pendingRoute,
    message,
    conversationId,
    onCreateConversationForSelection,
    conversationIdRef,
    mountedRef,
    editorRevisionsRef,
    textareaRef,
    clearMessage,
    setPendingRoute,
    setRouteCreationError,
    setCreatingRouteConversation,
  }: ComposerRouteConversationOptions): void => {
    if (!onCreateConversationForSelection || !pendingRoute) return;
    setRouteCreationError(null);
    setCreatingRouteConversation(true);
    const sourceEditorRevision = editorRevisionsRef.current.get(conversationId) ?? 0;
    const prefillText = message.trim() ? message : undefined;
    let createdConversationId: string | null = null;
    void onCreateConversationForSelection({
      selection: pendingRoute.selection,
      configuration: pendingRoute.configuration,
      ...(prefillText ? { prefillText } : {}),
      ...(pendingRoute.carriesContext ? { sourceConversationId: pendingRoute.sourceConversationId } : {}),
      onCreated: (createdId) => { createdConversationId = createdId; },
    }).then(
      () => {
        setPendingRoute(null);
        if (focusFrameRef.current !== null) window.cancelAnimationFrame(focusFrameRef.current);
        focusFrameRef.current = window.requestAnimationFrame(() => {
          focusFrameRef.current = null;
          if (createdConversationId !== null && conversationIdRef.current === createdConversationId) {
            textareaRef.current?.focus();
          }
        });
        if (!prefillText) return;
        if ((editorRevisionsRef.current.get(conversationId) ?? 0) !== sourceEditorRevision) return;
        if (mountedRef.current && conversationIdRef.current === conversationId) clearMessage();
        else clearPersistedComposerDraft(conversationId, prefillText);
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
  }, []);
}
