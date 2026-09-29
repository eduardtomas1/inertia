import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import type { ContinuationIdentity, Conversation, ModelSelection } from "@shared/contracts";

import { pendingModelRoute } from "../../utils/modelRouteTransition";
import type { ComposerProps, PendingModelRoute } from "./types";

export function useComposerNewChatOffer(options: {
  conversation: Conversation;
  latestTurn: { id: string; modelSelection: ModelSelection; continuationIdentity: ContinuationIdentity } | null;
  backendProfiles: NonNullable<ComposerProps["backendProfiles"]>;
  message: string;
  composerRef: RefObject<HTMLElement | null>;
  mountedRef: MutableRefObject<boolean>;
  conversationIdRef: MutableRefObject<string>;
  editorRevisionsRef: MutableRefObject<Map<string, number>>;
  blockedReason: string | null;
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
    mountedRef,
    conversationIdRef,
    editorRevisionsRef,
    blockedReason,
    onCreateConversationForSelection,
    setConversationUpdateError,
    updateMessage,
  } = options;
  const [pendingRoute, setPendingRoute] = useState<PendingModelRoute | null>(null);
  const [creatingRouteConversation, setCreatingRouteConversation] = useState(false);
  const [routeCreationError, setRouteCreationError] = useState<string | null>(null);
  const routeCancelRef = useRef<HTMLButtonElement>(null);

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
      selection,
      label,
      reason,
      configuration,
    ));
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

  const createRouteConversation = (): void => {
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
      prefillText || pendingRoute.configuration ? {
        ...(prefillText ? { prefillText } : {}),
        ...(pendingRoute.configuration ? { configuration: pendingRoute.configuration } : {}),
      } : undefined,
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
    createRouteConversation,
    resetNewChatOffer,
  };
}
