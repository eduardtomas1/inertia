import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { ConversationContextPacket } from "../../shared/conversation-context";
import {
  collectConversationContextExcerpts,
  conversationContextWorkspaceLabel,
  scrubConversationContextMetadata,
} from "./conversation-context-excerpts";
import { prepareConversationContextPacket } from "./conversation-context-transport";

export interface ContinuationHistoryBlock {
  label: string;
  content: string;
}

export interface ContinuationHistory {
  blocks: ContinuationHistoryBlock[];
  messageCount: number;
  omittedMessageCount: number;
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
  );
  if (!collected) return null;
  const { excerpts, droppedMessageCount } = collected;
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
  };
  if (capacityBytes <= 0) return unavailable;
  try {
    const prepared = prepareConversationContextPacket(packet, capacityBytes, "prompt", true);
    return {
      blocks: prepared.blocks.map(({ label, content }) => ({ label, content })),
      messageCount: prepared.packet.messageCount,
      omittedMessageCount: prepared.packet.droppedMessageCount,
    };
  } catch {
    return unavailable;
  }
}
