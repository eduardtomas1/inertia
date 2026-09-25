export const MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN = 3;
export const MAX_CONVERSATION_CONTEXT_MESSAGES = 2000;
export const MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES = 8 * 1024;
export const MAX_CONVERSATION_CONTEXT_TOTAL_BYTES = 256 * 1024;
export const MAX_CONVERSATION_CONTEXT_EXCERPTS_JSON_BYTES = 640 * 1024;
export const MAX_CONVERSATION_CONTEXT_NOTE_BYTES = 1024;
export const MAX_CONVERSATION_CONTEXT_SOURCE_MESSAGES = 2000;
export const MAX_CONVERSATION_CONTEXT_BLOCK_BYTES = 64 * 1024;
export const MAX_CONVERSATION_CONTEXT_BLOCKS_PER_PACKET = 3;
export const MAX_CONVERSATION_CONTEXT_TURN_BYTES =
  MAX_CONVERSATION_CONTEXT_BLOCK_BYTES * MAX_CONVERSATION_CONTEXT_BLOCKS_PER_PACKET;
export const MAX_CONVERSATION_CONTEXT_ATTACHMENTS_PER_MESSAGE = 8;

export type ConversationContextWorkspaceRelation =
  | "same-workspace"
  | "different-workspace";

/** Media stays in its own chat; a packet carries only its durable identity. */
export interface ConversationContextAttachmentReference {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface ConversationContextExcerpt {
  sourceMessageId: string;
  sourceTurnId: string | null;
  role: "user" | "assistant";
  content: string;
  truncated: boolean;
  createdAt: string;
  attachments?: ConversationContextAttachmentReference[];
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
  droppedMessageCount: number;
  createdAt: string;
  consumedMessageId: string | null;
  consumedAt: string | null;
  sourceState: "available" | "deleted";
}

export interface ConversationContextOmissions {
  earlierMessages: number;
  intermediateAgentUpdates: number;
  gapIndex: number;
}

export interface ConversationContextPacket
  extends ConversationContextPacketSummary {
  excerpts: ConversationContextExcerpt[];
  omissions?: ConversationContextOmissions;
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

/** Renderer-safe prompt for a host-owned, user-selected context disclosure. */
export interface AgentConversationContextRequest {
  requestId: string;
  targetConversationId: string;
  targetTurnId: string;
  requestedSourceConversationId: string | null;
  createdAt: string;
  expiresAt: string;
}

/**
 * Privileged materialization carried only after opaque packet IDs have been
 * checked against the destination conversation. Renderers never author this
 * object directly. One packet may span several ordered blocks.
 */
export interface MaterializedConversationContext {
  packetId: string;
  label: string;
  content: string;
  blockIndex: number;
  blockCount: number;
}

export function isOwnConversationContext(
  packet: Pick<ConversationContextPacketSummary, "sourceConversationId" | "targetConversationId">,
): boolean {
  return packet.sourceConversationId === packet.targetConversationId;
}
