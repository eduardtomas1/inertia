import { useEffect, type Dispatch, type SetStateAction } from "react";

import type {
  AgentTurn,
  Conversation,
  ConversationLatestTurnSummary,
} from "@shared/contracts";
import { providerNativeModelSelection } from "../../../../shared/model-routing";
import { subscribeProviderRouteSwitch } from "../../utils/providerRouteSwitch";
import type { PendingModelRoute } from "./types";

export function useComposerProviderRouteSwitch({
  conversation,
  latestTurn,
  latestTurnSummary,
  setPendingRoute,
  setRouteCreationError,
}: {
  conversation: Conversation;
  latestTurn: AgentTurn | null | undefined;
  latestTurnSummary: ConversationLatestTurnSummary | null | undefined;
  setPendingRoute: Dispatch<SetStateAction<PendingModelRoute | null>>;
  setRouteCreationError: Dispatch<SetStateAction<string | null>>;
}): void {
  useEffect(() => subscribeProviderRouteSwitch((request) => {
    if (request.conversationId !== conversation.id) return;
    const selection = providerNativeModelSelection({ providerId: request.providerId });
    const sourceLatestTurn = latestTurnSummary ?? latestTurn;
    setRouteCreationError(null);
    setPendingRoute({
      selection,
      label: "Antigravity",
      reason: "Gemini CLI no longer serves individual Google accounts. This chat stays as it is; the new chat starts fresh in Antigravity.",
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
      destinationRevision: selection.backendConfigurationRevision,
    });
  }), [
    conversation.continuationIdentity,
    conversation.id,
    conversation.modelSelection,
    conversation.projectId,
    latestTurn,
    latestTurnSummary,
    setPendingRoute,
    setRouteCreationError,
  ]);
}
