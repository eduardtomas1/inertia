import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type Database from "better-sqlite3";

import type {
  AgentContextReadAccess,
  AgentContextReadSummary,
  ChatAttachment,
  ProviderId,
} from "../../shared/contracts";
import type { AgentTurnStatus } from "../../shared/turn-lifecycle";
import { isHtmlRenderTitle } from "../../shared/html-render-reference";
import { normalizeIdentityPath } from "../project-identity";
import { readBoundedMessageText } from "./bounded-message-text";
import { parseStoredAttachments } from "./codecs";
import { scrubConversationContextMetadata as scrubMetadata } from "./conversation-context-excerpts";
import {
  CONVERSATION_CONTEXT_MESSAGE_SQL,
  continuationRouteTurnSql,
  type ContinuationRouteFilter,
} from "./conversation-context-source";
import { parseTurnGitArtifactFiles } from "./git-artifact-codecs";
import type { ConversationRow } from "./rows";

const MAX_TURN_ACTIVITIES = 2_000;
const MAX_TURN_MESSAGES = 500;
const MAX_REQUEST_HEAD_BYTES = 2_048;
const MAX_COMMAND_DETAIL_CHARS = 4_096;

export interface ConversationContextTurnReadContext {
  database: Database.Database;
  conversationPath(conversationId: string): string;
  requireConversation(conversationId: string): ConversationRow;
}

export interface ConversationContextTurnRow {
  id: string;
  userMessageId: string;
  providerId: ProviderId;
  model: string;
  status: AgentTurnStatus;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ConversationContextTurnListRow extends ConversationContextTurnRow {
  requestHead: Buffer;
}

export type ConversationContextTurnEntryRow =
  | {
      kind: "message";
      id: string;
      role: "user" | "assistant";
      createdAt: string;
      attachments: ChatAttachment[];
    }
  | { kind: "page"; id: string; title: string | null; createdAt: string }
  | {
      kind: "activity";
      id: string;
      activityKind: "command" | "tool" | "file" | "error";
      title: string;
      detail: string | null;
      status: "running" | "completed" | "failed";
      createdAt: string;
    };

export interface ConversationContextTurnFile {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
}

interface TurnRowRecord {
  id: string;
  user_message_id: string;
  provider_id: ProviderId;
  model: string;
  status: AgentTurnStatus;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface ReadRecord {
  target_user_message_id: string;
  target_turn_id: string;
  source_conversation_id: string;
  source_conversation_title: string;
  source_turn_id: string | null;
  access: AgentContextReadAccess;
  created_at: string;
  updated_at: string;
  source_available: 0 | 1;
}

const TURN_COLUMNS = `id, user_message_id, provider_id, model, status,
  requested_at, started_at, completed_at`;

function routeTurnSql(route: ContinuationRouteFilter | undefined): {
  sql: string;
  parameters: Array<string | null>;
} {
  if (!route) return { sql: "", parameters: [] };
  const routed = continuationRouteTurnSql("turn", route);
  return { sql: `AND ${routed.sql}`, parameters: routed.parameters };
}

function turnFromRecord(row: TurnRowRecord): ConversationContextTurnRow {
  return {
    id: row.id,
    userMessageId: row.user_message_id,
    providerId: row.provider_id,
    model: row.model,
    status: row.status,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

/**
 * Read-only persistence for the agent context tool: which chats a turn may
 * read, the turns of one chat, one turn's messages and records, and the
 * durable log of what the agent read.
 */
export class ConversationContextTurnReads {
  constructor(private readonly context: ConversationContextTurnReadContext) {}

  access(input: {
    targetConversationId: string;
    targetTurnId: string;
    targetUserMessageId: string;
    sourceConversationId: string;
  }): AgentContextReadAccess | null {
    const source = this.context.requireConversation(input.sourceConversationId);
    const target = this.context.requireConversation(input.targetConversationId);
    if (source.id === target.id) return "own";
    const sameWorkspace = this.sameWorkspace(source.id, target.id);
    const referenced = this.context.database.prepare(`
      SELECT packet.workspace_relation
      FROM conversation_context_packets packet
      WHERE packet.target_conversation_id = ?
        AND packet.consumed_message_id = ?
        AND packet.source_conversation_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM agent_context_requests request WHERE request.packet_id = packet.id
        )
    `).all(target.id, input.targetUserMessageId, source.id) as Array<{
      workspace_relation: "same-workspace" | "different-workspace";
    }>;
    if (referenced.some(({ workspace_relation }) =>
      sameWorkspace || workspace_relation === "different-workspace")) return "referenced";
    const approved = this.context.database.prepare(`
      SELECT packet.workspace_relation
      FROM agent_context_requests request
      JOIN conversation_context_packets packet ON packet.id = request.packet_id
      WHERE request.target_conversation_id = ?
        AND request.target_turn_id = ?
        AND request.status = 'completed'
        AND request.selected_source_conversation_id = ?
    `).all(target.id, input.targetTurnId, source.id) as Array<{
      workspace_relation: "same-workspace" | "different-workspace";
    }>;
    return approved.some(({ workspace_relation }) =>
      sameWorkspace || workspace_relation === "different-workspace")
      ? "approved"
      : null;
  }

  requestedByCall(targetTurnId: string, toolCallIdHash: string): boolean {
    return this.context.database.prepare(`
      SELECT 1 FROM agent_context_requests
      WHERE target_turn_id = ? AND tool_call_id_hash = ?
    `).get(targetTurnId, toolCallIdHash) !== undefined;
  }

  private sameWorkspace(sourceConversationId: string, targetConversationId: string): boolean {
    try {
      return normalizeIdentityPath(resolve(this.context.conversationPath(sourceConversationId)))
        === normalizeIdentityPath(resolve(this.context.conversationPath(targetConversationId)));
    } catch {
      return false;
    }
  }

  conversation(conversationId: string): ConversationRow {
    return this.context.requireConversation(conversationId);
  }

  turns(
    conversationId: string,
    limit: number,
    beforeTurnId?: string,
    route?: ContinuationRouteFilter,
  ): ConversationContextTurnListRow[] {
    const before = beforeTurnId ? this.turn(conversationId, beforeTurnId, route) : null;
    if (beforeTurnId && !before) throw new Error("That turn cursor is not part of this chat.");
    const routed = routeTurnSql(route);
    const rows = this.context.database.prepare(`
      SELECT ${TURN_COLUMNS},
        COALESCE((
          SELECT substr(CAST(message.content AS BLOB), 1, ?) FROM messages message
          WHERE message.id = turn.user_message_id
        ), X'') AS request_head
      FROM agent_turns turn
      WHERE turn.conversation_id = ?
        ${before ? "AND (turn.requested_at, turn.id) < (?, ?)" : ""}
        ${routed.sql}
      ORDER BY turn.requested_at DESC, turn.id DESC
      LIMIT ?
    `).all(
      MAX_REQUEST_HEAD_BYTES,
      conversationId,
      ...(before ? [before.requestedAt, before.id] : []),
      ...routed.parameters,
      limit,
    ) as Array<TurnRowRecord & { request_head: Buffer }>;
    return rows.map((row) => ({ ...turnFromRecord(row), requestHead: row.request_head }));
  }

  turn(
    conversationId: string,
    turnId: string,
    route?: ContinuationRouteFilter,
  ): ConversationContextTurnRow | null {
    const routed = routeTurnSql(route);
    const row = this.context.database.prepare(`
      SELECT ${TURN_COLUMNS} FROM agent_turns turn
      WHERE turn.id = ? AND turn.conversation_id = ? ${routed.sql}
    `).get(turnId, conversationId, ...routed.parameters) as TurnRowRecord | undefined;
    return row ? turnFromRecord(row) : null;
  }

  withheldTurnCount(conversationId: string, route: ContinuationRouteFilter): number {
    const routed = continuationRouteTurnSql("turn", route);
    return (this.context.database.prepare(`
      SELECT COUNT(*) AS count FROM agent_turns turn
      WHERE turn.conversation_id = ? AND NOT ${routed.sql}
    `).get(conversationId, ...routed.parameters) as { count: number }).count;
  }

  entries(conversationId: string, turn: ConversationContextTurnRow): {
    entries: ConversationContextTurnEntryRow[];
    recordsOmitted: boolean;
  } {
    const messageRows = this.context.database.prepare(`
      SELECT id, role, created_at, attachments_json,
        CASE WHEN role = 'system' THEN json_extract(html_render_json, '$.title') END AS page_title
      FROM messages
      WHERE conversation_id = ? AND (turn_id = ? OR id = ?)
        AND ${CONVERSATION_CONTEXT_MESSAGE_SQL}
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(conversationId, turn.id, turn.userMessageId, MAX_TURN_MESSAGES + 1) as Array<{
      id: string;
      role: "user" | "assistant" | "system";
      created_at: string;
      attachments_json: string;
      page_title: unknown;
    }>;
    const messages = messageRows.slice(0, MAX_TURN_MESSAGES).map((row): ConversationContextTurnEntryRow => row.role === "system"
      ? {
          kind: "page",
          id: row.id,
          title: isHtmlRenderTitle(row.page_title) ? row.page_title : null,
          createdAt: row.created_at,
        }
      : {
          kind: "message",
          id: row.id,
          role: row.role,
          createdAt: row.created_at,
          attachments: parseStoredAttachments(row.attachments_json),
        });
    const activityRows = this.context.database.prepare(`
      SELECT id, kind, title, status, created_at,
        CASE WHEN kind = 'command' THEN substr(detail, 1, ?) END AS detail
      FROM activities
      WHERE conversation_id = ? AND turn_id = ?
        AND kind IN ('command', 'tool', 'file', 'error')
      ORDER BY created_at ASC, rowid ASC
      LIMIT ?
    `).all(MAX_COMMAND_DETAIL_CHARS, conversationId, turn.id, MAX_TURN_ACTIVITIES + 1) as Array<{
      id: string;
      kind: "command" | "tool" | "file" | "error";
      title: string;
      detail: string | null;
      status: "running" | "completed" | "failed";
      created_at: string;
    }>;
    const activities = activityRows.slice(0, MAX_TURN_ACTIVITIES).map((row): ConversationContextTurnEntryRow => ({
      kind: "activity",
      id: row.id,
      activityKind: row.kind,
      title: row.title,
      detail: row.detail,
      status: row.status,
      createdAt: row.created_at,
    }));
    const request = messages.findIndex(({ id }) => id === turn.userMessageId);
    const ordered = [...messages.filter((_, index) => index !== request), ...activities]
      .sort((left, right) => left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0);
    return {
      entries: request === -1 ? ordered : [messages[request]!, ...ordered],
      recordsOmitted: messageRows.length > MAX_TURN_MESSAGES || activityRows.length > MAX_TURN_ACTIVITIES,
    };
  }

  requestAttachments(conversationId: string, turn: ConversationContextTurnRow): ChatAttachment[] {
    const row = this.context.database.prepare(`
      SELECT attachments_json FROM messages
      WHERE id = ? AND conversation_id = ? AND role = 'user'
    `).get(turn.userMessageId, conversationId) as { attachments_json: string } | undefined;
    return row ? parseStoredAttachments(row.attachments_json) : [];
  }

  messageText(messageId: string, maximumBytes: number): { content: string; truncated: boolean } {
    const row = this.context.database.prepare(`
      SELECT COALESCE(substr(CAST(content AS BLOB), 1, ?), X'') AS content
      FROM messages WHERE id = ?
    `).get(maximumBytes + 1, messageId) as { content: Buffer } | undefined;
    if (!row) return { content: "", truncated: false };
    const chunks = this.context.database.prepare(`
      SELECT substr(CAST(content AS BLOB), 1, ?) AS content
      FROM message_content_chunks WHERE message_id = ? ORDER BY sequence LIMIT ?
    `);
    return readBoundedMessageText(
      row.content,
      () => chunks.iterate(maximumBytes + 1, messageId, maximumBytes + 1) as Iterable<{ content: Buffer }>,
      maximumBytes,
    );
  }

  files(turnId: string): ConversationContextTurnFile[] {
    const row = this.context.database.prepare(`
      SELECT files_json FROM turn_git_artifacts
      WHERE turn_id = ? AND status IN ('ready', 'partial')
    `).get(turnId) as { files_json: string } | undefined;
    return row
      ? parseTurnGitArtifactFiles(row.files_json).map((file) => ({
          path: file.path,
          status: file.status,
          insertions: file.insertions,
          deletions: file.deletions,
        }))
      : [];
  }

  recordRead(input: {
    targetConversationId: string;
    targetTurnId: string;
    targetUserMessageId: string;
    sourceConversationId: string;
    sourceTurnId: string | null;
    access: AgentContextReadAccess;
    now: string;
  }): boolean {
    return this.context.database.transaction(() => {
      const updated = this.context.database.prepare(`
        UPDATE agent_context_reads
        SET page_count = page_count + 1, updated_at = ?
        WHERE target_turn_id = ? AND source_conversation_id = ?
          AND ifnull(source_turn_id, '') = ?
      `).run(input.now, input.targetTurnId, input.sourceConversationId, input.sourceTurnId ?? "");
      if (updated.changes > 0) return false;
      const source = this.context.requireConversation(input.sourceConversationId);
      this.context.database.prepare(`
        INSERT INTO agent_context_reads (
          id, target_conversation_id, target_turn_id, target_user_message_id,
          source_conversation_id, source_conversation_title, source_turn_id,
          access, page_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        randomUUID(),
        input.targetConversationId,
        input.targetTurnId,
        input.targetUserMessageId,
        source.id,
        scrubMetadata(source.title, "Source chat", 120),
        input.sourceTurnId,
        input.access,
        input.now,
        input.now,
      );
      return true;
    })();
  }
}

export function agentContextReadSummaries(
  database: Database.Database,
  targetConversationId: string,
  messageIds?: readonly string[],
): AgentContextReadSummary[] {
  if (messageIds?.length === 0) return [];
  const rows = database.prepare(`
    SELECT target_user_message_id, target_turn_id, source_conversation_id,
      source_conversation_title, source_turn_id, access, created_at, updated_at,
      EXISTS(
        SELECT 1 FROM conversations source WHERE source.id = reads.source_conversation_id
      ) AS source_available
    FROM agent_context_reads reads
    WHERE target_conversation_id = ?
      ${messageIds ? `AND target_user_message_id IN (${messageIds.map(() => "?").join(", ")})` : ""}
    ORDER BY created_at ASC, id ASC
  `).all(targetConversationId, ...(messageIds ?? [])) as ReadRecord[];
  const summaries = new Map<string, AgentContextReadSummary>();
  for (const row of rows) {
    const key = `${row.target_turn_id}\0${row.source_conversation_id}`;
    const summary = summaries.get(key) ?? {
      targetMessageId: row.target_user_message_id,
      targetTurnId: row.target_turn_id,
      sourceConversationId: row.source_conversation_id,
      sourceConversationTitle: row.source_conversation_title,
      sourceState: row.source_available === 1 ? "available" as const : "deleted" as const,
      access: row.access,
      listedTurns: false,
      turnIds: [],
      firstReadAt: row.created_at,
      lastReadAt: row.updated_at,
    };
    if (row.source_turn_id === null) summary.listedTurns = true;
    else summary.turnIds.push(row.source_turn_id);
    if (row.updated_at > summary.lastReadAt) summary.lastReadAt = row.updated_at;
    summaries.set(key, summary);
  }
  return [...summaries.values()];
}
