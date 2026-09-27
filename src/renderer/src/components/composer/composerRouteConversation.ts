import type { Dispatch, MutableRefObject, SetStateAction } from "react";

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

export function createComposerRouteConversation({
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
}: ComposerRouteConversationOptions): void {
  if (!onCreateConversationForSelection || !pendingRoute) return;
  setRouteCreationError(null);
  setCreatingRouteConversation(true);
  const sourceEditorRevision = editorRevisionsRef.current.get(conversationId) ?? 0;
  const prefillText = message.trim() ? message : undefined;
  void onCreateConversationForSelection(
    pendingRoute.selection,
    prefillText || pendingRoute.configuration ? {
      ...(prefillText ? { prefillText } : {}),
      ...(pendingRoute.configuration ? { configuration: pendingRoute.configuration } : {}),
    } : undefined,
  ).then(
    () => {
      setPendingRoute(null);
      if (!prefillText) return;
      window.requestAnimationFrame(() => textareaRef.current?.focus());
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
}
