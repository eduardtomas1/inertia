import {
  MAX_RUNTIME_ATTACHMENT_CONVERSATIONS,
  type RuntimeAttachmentConversationsEvent,
  type RuntimeAttachmentConversationsQuery,
} from "../node/runtime-attachment-protocol.js";

export interface RuntimeAttachmentConversationReader {
  attachmentConversations(attachmentId: string): readonly string[];
}

/** Answers main's question of which chats sent a stored attachment, before it lets a chat re-attach it. */
export function answerRuntimeAttachmentConversations(
  runtime: RuntimeAttachmentConversationReader | null,
  command: RuntimeAttachmentConversationsQuery,
): RuntimeAttachmentConversationsEvent {
  const rejected = (message: string): RuntimeAttachmentConversationsEvent => ({
    type: "runtime.attachment-conversations-rejected", requestId: command.requestId, message,
  });
  if (!runtime) return rejected("The local runtime is not ready.");
  try {
    const conversationIds = [...new Set(runtime.attachmentConversations(command.attachmentId))];
    return conversationIds.length > MAX_RUNTIME_ATTACHMENT_CONVERSATIONS
      ? rejected("The attachment's chats could not be read.")
      : { type: "runtime.attachment-conversations-resolved", requestId: command.requestId, conversationIds };
  } catch {
    return rejected("The attachment's chats could not be read.");
  }
}
