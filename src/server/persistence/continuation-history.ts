import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
  MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES,
  MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN,
  MAX_CONVERSATION_CONTEXT_UPDATE_EXCERPT_BYTES,
  type ConversationContextExcerpt,
  type ConversationContextPacket,
} from "../../shared/conversation-context";
import { byteLength } from "./bounded-message-text";
import {
  collectConversationContextExcerpts,
  conversationContextWorkspaceLabel,
  scrubConversationContextMetadata,
} from "./conversation-context-excerpts";
import type { ContinuationRouteFilter } from "./conversation-context-source";
import {
  sentConversationContextReferences,
  type SentConversationContextReference,
} from "./conversation-context-packet-repository";
import { prepareConversationContextPacket } from "./conversation-context-transport";
import { providerHandoffBlockBytes } from "./provider-handoff-files";

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

function markReferences(
  excerpts: readonly ConversationContextExcerpt[],
  references: readonly SentConversationContextReference[],
): ConversationContextExcerpt[] {
  const notes = new Map<string, string>();
  for (const { messageId, title } of references) {
    notes.set(messageId, `${notes.get(messageId) ?? ""}\n\n[referenced chat: ${title}]`);
  }
  return excerpts.map((excerpt) => {
    const note = notes.get(excerpt.sourceMessageId);
    return note ? { ...excerpt, content: `${excerpt.content}${note}` } : excerpt;
  });
}

function sentReferenceBlocks(
  references: readonly SentConversationContextReference[],
  keptMessageIds: ReadonlySet<string>,
  roomBytes: number,
): ContinuationHistoryBlock[] {
  const included: ContinuationHistoryBlock[][] = [];
  let room = roomBytes;
  const newest = references
    .filter(({ messageId }) => keptMessageIds.has(messageId))
    .slice(-MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN)
    .reverse();
  for (const reference of newest) {
    const blocks = reference.sentBlocks()?.map(({ label, content }) => ({
      label, content, optional: true as const,
    }));
    if (!blocks) continue;
    const bytes = blocks.reduce((total, block) => total + providerHandoffBlockBytes(block), 0);
    if (bytes > room) continue;
    room -= bytes;
    included.unshift(blocks);
  }
  return included.flat();
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
  const { droppedMessageCount, withheldMessageCount } = collected;
  const references = sentConversationContextReferences(
    database,
    source.id,
    collected.excerpts.filter(({ role }) => role === "user").map(({ sourceMessageId }) => sourceMessageId),
  );
  const excerpts = markReferences(collected.excerpts, references);
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
    const restored = prepared.blocks.map(({ label, content }) => ({ label, content }));
    return {
      blocks: [...restored, ...sentReferenceBlocks(
        references,
        new Set(prepared.packet.excerpts.map(({ sourceMessageId }) => sourceMessageId)),
        capacityBytes - restored.reduce((total, { content }) => total + byteLength(JSON.stringify(content)), 0),
      )],
      messageCount: prepared.packet.messageCount,
      omittedMessageCount: prepared.packet.droppedMessageCount,
      ...withheld,
    };
  } catch {
    return unavailable;
  }
}
