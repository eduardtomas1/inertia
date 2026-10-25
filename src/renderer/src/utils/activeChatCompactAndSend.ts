import type {
  ChatAttachment,
  ConversationCompactAndSendResult,
  TurnRequestContext,
} from "@shared/contracts";

export function activeChatCompactAndSend(
  conversationId: string | null,
  compactAndSend: (
    conversationId: string,
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
    activate?: boolean,
  ) => Promise<ConversationCompactAndSendResult>,
): (content: string, attachments: ChatAttachment[], context?: TurnRequestContext) => Promise<ConversationCompactAndSendResult> {
  return async (content, attachments, context) => {
    if (!conversationId) throw new Error("This chat is not ready to send.");
    return await compactAndSend(conversationId, content, attachments, context, false);
  };
}
