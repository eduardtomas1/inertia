export const MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN = 2;
export const MAX_CONVERSATION_CONTEXT_MESSAGES = 12;
export const MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES = 4 * 1024;
export const MAX_CONVERSATION_CONTEXT_TOTAL_BYTES = 12 * 1024;
export const MAX_CONVERSATION_CONTEXT_NOTE_BYTES = 1024;
export const MAX_CONVERSATION_CONTEXT_SOURCE_MESSAGES = 80;

export type ConversationContextWorkspaceRelation =
  | "same-workspace"
  | "different-workspace";

export interface ConversationContextExcerpt {
  sourceMessageId: string;
  sourceTurnId: string | null;
  role: "user" | "assistant";
  content: string;
  truncated: boolean;
  createdAt: string;
}

export interface ConversationContextPacketSummary {
  id: string;
  sourceConversationId: string;
  targetConversationId: string;
  sourceProjectId: string;
  targetProjectId: string;
  sourceConversationTitle: string;
  sourceProjectName: string;
  sourceWorkspaceLabel: string;
  targetWorkspaceLabel: string;
  workspaceRelation: ConversationContextWorkspaceRelation;
  note: string | null;
  messageCount: number;
  characterCount: number;
  createdAt: string;
  consumedMessageId: string | null;
  consumedAt: string | null;
  sourceState: "available" | "deleted";
}

export interface ConversationContextPacket
  extends ConversationContextPacketSummary {
  excerpts: ConversationContextExcerpt[];
}

export interface ConversationContextSourceTranscript {
  conversationId: string;
  projectId: string;
  conversationTitle: string;
  projectName: string;
  workspaceLabel: string;
  targetConversationId: string;
  targetProjectId: string;
  targetWorkspaceLabel: string;
  workspaceRelation: ConversationContextWorkspaceRelation;
  messages: ConversationContextExcerpt[];
}

/**
 * Privileged materialization carried only after opaque packet IDs have been
 * checked against the destination conversation. Renderers never author this
 * object directly.
 */
export interface MaterializedConversationContext {
  packetId: string;
  label: string;
  content: string;
}
