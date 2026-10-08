import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
  MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES,
  MAX_CONVERSATION_CONTEXT_UPDATE_EXCERPT_BYTES,
  type ConversationContextPacket,
} from "../../shared/conversation-context";
import {
  collectConversationContextExcerpts,
  conversationContextWorkspaceLabel,
  scrubConversationContextMetadata,
} from "./conversation-context-excerpts";
import type { ContinuationRouteFilter } from "./conversation-context-source";
import { prepareConversationContextPacket } from "./conversation-context-transport";

export interface ContinuationHistoryBlock {
  label: string;
  content: string;
  /** Supplementary context dropped first when the restored history does not fit. */
  optional?: true;
}

export interface ContinuationHistory {
  blocks: ContinuationHistoryBlock[];
  messageCount: number;
  omittedMessageCount: number;
  withheldMessageCount?: number;
}

interface ContinuationHistorySourceRow {
  id: string;
  project_id: string;
  title: string;
  branch: string | null;
  worktree_path: string | null;
  project_name: string;
}

export function readContinuationHistory(
  database: Database.Database,
  conversationId: string,
  capacityBytes: number,
  capturedAt: string,
  excludedMessageId?: string,
  route?: ContinuationRouteFilter,
): ContinuationHistory | null {
  const source = database.prepare(`
    SELECT conversation.id, conversation.project_id, conversation.title,
      conversation.branch, conversation.worktree_path, project.name AS project_name
    FROM conversations AS conversation
    JOIN projects AS project ON project.id = conversation.project_id
    WHERE conversation.id = ?
  `).get(conversationId) as ContinuationHistorySourceRow | undefined;
  if (!source) return null;
  const collected = collectConversationContextExcerpts(
    database,
    source.id,
    null,
    excludedMessageId,
    route,
    Math.min(
      MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES,
      Math.max(MAX_CONVERSATION_CONTEXT_UPDATE_EXCERPT_BYTES, Math.floor(capacityBytes / 4)),
    ),
  );
  if (!collected) return null;
  const { excerpts, droppedMessageCount, withheldMessageCount } = collected;
  const withheld = withheldMessageCount > 0 ? { withheldMessageCount } : {};
  if (excerpts.length === 0) {
    return { blocks: [], messageCount: 0, omittedMessageCount: 0, ...withheld };
  }
  const workspaceLabel = scrubConversationContextMetadata(
    conversationContextWorkspaceLabel(source),
    "Workspace",
    280,
  );
  const packet: ConversationContextPacket = {
    id: randomUUID(),
    sourceConversationId: source.id,
    targetConversationId: source.id,
    sourceProjectId: source.project_id,
    targetProjectId: source.project_id,
    sourceConversationTitle: scrubConversationContextMetadata(source.title, "This chat", 120),
    sourceProjectName: scrubConversationContextMetadata(source.project_name, "Project", 80),
    sourceWorkspaceLabel: workspaceLabel,
    targetWorkspaceLabel: workspaceLabel,
    workspaceRelation: "same-workspace",
    note: null,
    messageCount: excerpts.length,
    characterCount: excerpts.reduce((total, excerpt) => total + excerpt.content.length, 0),
    droppedMessageCount,
    createdAt: capturedAt,
    consumedMessageId: null,
    consumedAt: null,
    sourceState: "available",
    excerpts,
  };
  const unavailable: ContinuationHistory = {
    blocks: [],
    messageCount: 0,
    omittedMessageCount: excerpts.length + droppedMessageCount,
    ...withheld,
  };
  if (capacityBytes <= 0) return unavailable;
  try {
    const prepared = prepareConversationContextPacket(packet, capacityBytes, "prompt", true);
    return {
      blocks: prepared.blocks.map(({ label, content }) => ({ label, content })),
      messageCount: prepared.packet.messageCount,
      omittedMessageCount: prepared.packet.droppedMessageCount,
      ...withheld,
    };
  } catch {
    return unavailable;
  }
}
