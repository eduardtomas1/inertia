import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import type { ContinuationIdentity, Conversation, ModelSelection } from "@shared/contracts";
import { conversationHasHistory } from "../../../../shared/continuation-policy";

import { pendingModelRoute, replacementChatRequest } from "../../utils/modelRouteTransition";
import { takeRouteConversationFocus, useComposerRouteConversation } from "./composerRouteConversation";
import type { ComposerProps, PendingModelRoute } from "./types";

export function useComposerNewChatOffer(options: {
  conversation: Conversation;
  latestTurn: { id: string; modelSelection: ModelSelection; continuationIdentity: ContinuationIdentity } | null;
  backendProfiles: NonNullable<ComposerProps["backendProfiles"]>;
  message: string;
  composerRef: RefObject<HTMLElement | null>;
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>;
  mountedRef: MutableRefObject<boolean>;
  conversationIdRef: MutableRefObject<string>;
  editorRevisionsRef: MutableRefObject<Map<string, number>>;
  blockedReason: string | null;
  scratchWorkspace: boolean;
  onCreateConversationForSelection: ComposerProps["onCreateConversationForSelection"];
  setConversationUpdateError: (message: string | null) => void;
  updateMessage: (message: string) => void;
}) {
  const {
    conversation,
    latestTurn,
    backendProfiles,
    message,
    composerRef,
    textareaRef,
    mountedRef,
    conversationIdRef,
    editorRevisionsRef,
    blockedReason,
    scratchWorkspace,
    onCreateConversationForSelection,
    setConversationUpdateError,
    updateMessage,
  } = options;
  const [pendingRoute, setPendingRoute] = useState<PendingModelRoute | null>(null);
  const [creatingRouteConversation, setCreatingRouteConversation] = useState(false);
  const [routeCreationError, setRouteCreationError] = useState<string | null>(null);
  const routeCancelRef = useRef<HTMLButtonElement>(null);
  const offerOriginRef = useRef<HTMLElement | null>(null);
  const routeConversation = useComposerRouteConversation();

  useEffect(() => {
    offerOriginRef.current = null;
  }, [conversation.id, conversation.modelSelection]);

  useEffect(() => {
    if (!takeRouteConversationFocus(conversation.id)) return;
    const frame = window.requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [conversation.id, textareaRef]);

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
    const latestTurnId = latestTurn?.id ?? null;
    const latestTurnKey = JSON.stringify(latestTurn
      ? {
          id: latestTurn.id,
          modelSelection: latestTurn.modelSelection,
          continuationIdentity: latestTurn.continuationIdentity,
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
      || pendingRoute.sourceConfigurationKey !== `${conversation.accessMode}:${conversation.interactionMode}`
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
    conversation.accessMode,
    conversation.continuationIdentity,
    conversation.id,
    conversation.interactionMode,
    conversation.modelSelection,
    conversation.projectId,
    backendProfiles,
    latestTurn,
    pendingRoute,
  ]);

  const offerNewChat = (
    selection: PendingModelRoute["selection"],
    label: string,
    reason: string,
    configuration?: PendingModelRoute["configuration"],
  ): void => {
    if (!onCreateConversationForSelection) {
      setConversationUpdateError(
        "Return this chat to the main window to choose a model that requires a new chat.",
      );
      return;
    }
    setRouteCreationError(null);
    setPendingRoute(pendingModelRoute(
      conversation,
      latestTurn,
      replacementChatRequest(conversation, {
        selection,
        configuration,
        ...(conversationHasHistory(conversation) && !scratchWorkspace
          ? { sourceConversationId: conversation.id }
          : {}),
      }),
      label,
      reason,
    ));
  };

  const dismissPendingRoute = (): void => {
    const origin = offerOriginRef.current;
    offerOriginRef.current = null;
    setPendingRoute(null);
    setRouteCreationError(null);
    window.requestAnimationFrame(() => {
      (origin?.isConnected ? origin : composerRef.current
        ?.querySelector<HTMLButtonElement>(".selected-model-chip"))
        ?.focus();
    });
  };

  const rememberOfferOrigin = (origin: HTMLElement): void => {
    offerOriginRef.current = origin;
  };

  const createRouteConversation = (): void => {
    offerOriginRef.current = null;
    routeConversation({
      pendingRoute,
      message,
      conversationId: conversation.id,
      onCreateConversationForSelection,
      conversationIdRef,
      mountedRef,
      editorRevisionsRef,
      textareaRef,
      clearMessage: () => updateMessage(""),
      setPendingRoute,
      setRouteCreationError,
      setCreatingRouteConversation,
    });
  };

  const resetNewChatOffer = useCallback((): void => {
    setPendingRoute(null);
    setCreatingRouteConversation(false);
  }, []);

  return {
    pendingRoute,
    creatingRouteConversation,
    routeCancelRef,
    canCreateRouteConversation: Boolean(
      onCreateConversationForSelection && !(pendingRoute && blockedReason),
    ),
    routeCreationBlockedReason: (pendingRoute ? blockedReason : null) ?? routeCreationError,
    offerNewChat,
    dismissPendingRoute,
    rememberOfferOrigin,
    createRouteConversation,
    resetNewChatOffer,
  };
}
