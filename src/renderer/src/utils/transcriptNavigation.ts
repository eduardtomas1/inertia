import type { MessageSendAcceptance } from "@shared/contracts";

export type TranscriptMessageSendAcceptance = MessageSendAcceptance & {
  materializedFromConversationId?: string;
};

export type TranscriptNavigationState =
  | { mode: "follow-latest"; conversationId: string | null }
  | { mode: "reading-history"; conversationId: string | null }
  | { mode: "await-turn"; conversationId: string; turnId: string }
  | { mode: "follow-turn"; conversationId: string; turnId: string };

export type TranscriptNavigationAction =
  | { type: "conversation.changed"; conversationId: string | null }
  | {
      type: "message.accepted";
      acceptance: TranscriptMessageSendAcceptance;
      sourceConversationId: string | null;
    }
  | { type: "turn.anchored"; conversationId: string; turnId: string }
  | { type: "turn.anchor-cancelled"; conversationId: string; turnId: string }
  | {
      type: "reader.scrolled";
      conversationId: string;
      followsLatest: boolean;
      intentional: boolean;
    }
  | { type: "latest.requested"; conversationId: string };

export function initialTranscriptNavigation(
  conversationId: string | null,
): TranscriptNavigationState {
  return { mode: "follow-latest", conversationId };
}

export function transcriptNavigationReducer(
  state: TranscriptNavigationState,
  action: TranscriptNavigationAction,
): TranscriptNavigationState {
  switch (action.type) {
    case "conversation.changed":
      return state.conversationId === action.conversationId
        ? state
        : initialTranscriptNavigation(action.conversationId);
    case "message.accepted": {
      const { acceptance } = action;
      if (
        acceptance.disposition !== "new-turn"
        || (
          acceptance.conversationId !== state.conversationId
          && (
            action.sourceConversationId !== state.conversationId
            || acceptance.materializedFromConversationId
              !== state.conversationId
          )
        )
      ) return state;
      if (
        (state.mode === "await-turn" || state.mode === "follow-turn")
        && state.turnId === acceptance.turnId
      ) return state;
      return {
        mode: "await-turn",
        conversationId: acceptance.conversationId,
        turnId: acceptance.turnId,
      };
    }
    case "turn.anchored":
      return state.mode === "await-turn"
        && state.conversationId === action.conversationId
        && state.turnId === action.turnId
        ? {
            mode: "follow-turn",
            conversationId: action.conversationId,
            turnId: action.turnId,
          }
        : state;
    case "turn.anchor-cancelled":
      return state.mode === "await-turn"
        && state.conversationId === action.conversationId
        && state.turnId === action.turnId
        ? {
            mode: "reading-history",
            conversationId: action.conversationId,
          }
        : state;
    case "reader.scrolled":
      if (action.conversationId !== state.conversationId) return state;
      if (!action.intentional && state.mode !== "follow-latest") return state;
      return action.followsLatest
        ? { mode: "follow-latest", conversationId: action.conversationId }
        : { mode: "reading-history", conversationId: action.conversationId };
    case "latest.requested":
      return action.conversationId === state.conversationId
        ? { mode: "follow-latest", conversationId: action.conversationId }
        : state;
  }
}

export function transcriptNavigationFollowsContent(
  state: TranscriptNavigationState,
): boolean {
  return state.mode === "follow-latest" || state.mode === "follow-turn";
}

export function isTranscriptReaderNavigationKey(key: string): boolean {
  return key === "ArrowUp"
    || key === "ArrowDown"
    || key === "PageUp"
    || key === "PageDown"
    || key === "Home"
    || key === "End"
    || key === " ";
}
