import type { Conversation, Project } from "../../shared/contracts";
import type { ConversationWorkspaceIdentity } from "../runtime/conversation-work-authority";

export { ConversationWorkAuthority } from "../runtime/conversation-work-authority";

interface StoredConversationWorkspaceSource {
  conversation(conversationId: string): Conversation;
  project(projectId: string): Project;
}

// This resolver is for in-memory reservation identity only. Filesystem work
// must continue through RuntimeStore.conversationPath and its path authority.
export function storedConversationWorkspaceResolver(
  source: StoredConversationWorkspaceSource,
): (conversationId: string) => ConversationWorkspaceIdentity {
  return (conversationId) => {
    const conversation = source.conversation(conversationId);
    return {
      projectId: conversation.projectId,
      checkoutPath: conversation.worktreePath
        ?? source.project(conversation.projectId).path,
    };
  };
}
