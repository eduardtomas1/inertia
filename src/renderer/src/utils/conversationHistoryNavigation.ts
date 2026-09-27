export const CONVERSATION_HISTORY_PREPEND_EVENT = "inertia:conversation-history-prepend";

export function prepareConversationHistoryPrepend(conversationId: string): void {
  window.dispatchEvent(new CustomEvent(CONVERSATION_HISTORY_PREPEND_EVENT, { detail: { conversationId } }));
}
