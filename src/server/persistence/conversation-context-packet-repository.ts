import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type Database from "better-sqlite3";

import {
  MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES,
  MAX_CONVERSATION_CONTEXT_MESSAGES,
  MAX_CONVERSATION_CONTEXT_NOTE_BYTES,
  MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN,
  MAX_CONVERSATION_CONTEXT_SOURCE_MESSAGES,
  MAX_CONVERSATION_CONTEXT_TOTAL_BYTES,
  type ConversationContextExcerpt,
  type ConversationContextPacket,
  type ConversationContextPacketSummary,
  type ConversationContextSourceTranscript,
  type MaterializedConversationContext,
  type MessageSendAcceptance,
} from "../../shared/contracts";
import { normalizeIdentityPath } from "../project-identity";
import { boundedSubagentText } from "../provider/subagent-trace";
import type { ConversationRow, MessageRow, ProjectRow } from "./rows";
import { MESSAGE_PROJECTION_COLUMNS } from "./stream-text-storage";

interface ConversationContextPacketRow {
  id: string;
  source_conversation_id: string;
  target_conversation_id: string;
  source_project_id: string;
  target_project_id: string;
  source_conversation_title: string;
  source_project_name: string;
  source_workspace_label: string;
  target_workspace_label: string;
  workspace_relation: "same-workspace" | "different-workspace";
  note: string | null;
  excerpts_json: string;
  message_count: number;
  character_count: number;
  created_at: string;
  consumed_message_id: string | null;
  consumed_request_id: string | null;
  consumed_at: string | null;
}

export type ConversationContextReplay =
  | MessageSendAcceptance
  | { kind: "transcript-only" };

export interface CreateConversationContextPacketInput {
  sourceConversationId: string;
  targetConversationId: string;
  sourceMessageIds: readonly string[];
  note?: string;
  acknowledgedWorkspaceDifference: boolean;
}

interface ConversationContextPacketPersistenceContext {
  database: Database.Database;
  conversationPath(conversationId: string): string;
  requireConversation(conversationId: string): ConversationRow;
  requireProject(projectId: string): ProjectRow;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maximumBytes: number): {
  text: string;
  truncated: boolean;
} {
  if (byteLength(value) <= maximumBytes) {
    return { text: value, truncated: false };
  }
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(value.slice(0, middle)) <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return { text: value.slice(0, low), truncated: true };
}

/**
 * Defense-in-depth only. The user previews the exact bounded copy because any
 * visible chat prose may legitimately contain material no pattern can detect.
 */
function scrubAndBoundExcerpt(
  row: Pick<MessageRow, "id" | "turn_id" | "role" | "content" | "created_at">,
  remainingBytes = MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES,
): ConversationContextExcerpt {
  const scrubbed = boundedSubagentText(row.content, row.content.length)
    ?? "[Empty message omitted]";
  const bounded = truncateUtf8(
    scrubbed.replace(/\r\n?/gu, "\n"),
    Math.min(MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES, remainingBytes),
  );
  return {
    sourceMessageId: row.id,
    sourceTurnId: row.turn_id,
    role: row.role as "user" | "assistant",
    content: bounded.text,
    truncated: bounded.truncated,
    createdAt: row.created_at,
  };
}

function parseExcerpts(row: ConversationContextPacketRow): ConversationContextExcerpt[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.excerpts_json);
  } catch {
    throw new Error("The saved chat context is malformed.");
  }
  if (!Array.isArray(parsed) || parsed.length !== row.message_count) {
    throw new Error("The saved chat context no longer matches its provenance.");
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  let totalBytes = 0;
  let totalCharacters = 0;
  const messageIds = new Set<string>();
  for (const value of parsed) {
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
    ) {
      throw new Error("The saved chat context contains a malformed excerpt.");
    }
    const excerpt = value as Record<string, unknown>;
    const keys = Object.keys(excerpt).sort();
    if (
      keys.join("\0") !== [
        "content",
        "createdAt",
        "role",
        "sourceMessageId",
        "sourceTurnId",
        "truncated",
      ].sort().join("\0")
      || typeof excerpt.sourceMessageId !== "string"
      || !uuid.test(excerpt.sourceMessageId)
      || messageIds.has(excerpt.sourceMessageId)
      || (
        excerpt.sourceTurnId !== null
        && (typeof excerpt.sourceTurnId !== "string" || !uuid.test(excerpt.sourceTurnId))
      )
      || (excerpt.role !== "user" && excerpt.role !== "assistant")
      || typeof excerpt.content !== "string"
      || excerpt.content.length < 1
      || typeof excerpt.truncated !== "boolean"
      || typeof excerpt.createdAt !== "string"
      || !Number.isFinite(Date.parse(excerpt.createdAt))
    ) {
      throw new Error("The saved chat context contains a malformed excerpt.");
    }
    const excerptBytes = byteLength(excerpt.content);
    if (excerptBytes > MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES) {
      throw new Error("The saved chat context exceeds the excerpt size limit.");
    }
    messageIds.add(excerpt.sourceMessageId);
    totalBytes += excerptBytes;
    totalCharacters += excerpt.content.length;
  }
  if (
    totalBytes > MAX_CONVERSATION_CONTEXT_TOTAL_BYTES
    || totalCharacters !== row.character_count
  ) {
    throw new Error("The saved chat context no longer matches its size provenance.");
  }
  return parsed as ConversationContextExcerpt[];
}

function packetFromRow(
  row: ConversationContextPacketRow,
  sourceAvailable: boolean,
): ConversationContextPacket {
  return {
    id: row.id,
    sourceConversationId: row.source_conversation_id,
    targetConversationId: row.target_conversation_id,
    sourceProjectId: row.source_project_id,
    targetProjectId: row.target_project_id,
    sourceConversationTitle: row.source_conversation_title,
    sourceProjectName: row.source_project_name,
    sourceWorkspaceLabel: row.source_workspace_label,
    targetWorkspaceLabel: row.target_workspace_label,
    workspaceRelation: row.workspace_relation,
    note: row.note,
    messageCount: row.message_count,
    characterCount: row.character_count,
    createdAt: row.created_at,
    consumedMessageId: row.consumed_message_id,
    consumedAt: row.consumed_at,
    sourceState: sourceAvailable ? "available" : "deleted",
    excerpts: parseExcerpts(row),
  };
}

function summaryFromPacket(
  packet: ConversationContextPacket,
): ConversationContextPacketSummary {
  const { excerpts: _excerpts, ...summary } = packet;
  return summary;
}

function workspaceLabel(conversation: ConversationRow): string {
  if (conversation.worktree_path) {
    return conversation.branch
      ? `Isolated worktree · ${conversation.branch}`
      : "Isolated worktree";
  }
  return conversation.branch
    ? `Project checkout · ${conversation.branch}`
    : "Project checkout";
}

function scrubMetadata(value: string, fallback: string, maxLength: number): string {
  return (boundedSubagentText(value, value.length) ?? fallback)
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength) || fallback;
}

function uniquePacketIds(ids: readonly string[]): string[] {
  if (
    ids.length < 1
    || ids.length > MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN
    || new Set(ids).size !== ids.length
  ) {
    throw new Error("Select one or two unique chat context packets.");
  }
  return [...ids];
}

export function claimConversationContextPackets(
  database: Database.Database,
  input: {
    packetIds: readonly string[];
    targetConversationId: string;
    messageId: string;
    requestId: string;
    consumedAt: string;
  },
): void {
  const ids = uniquePacketIds(input.packetIds);
  const claim = database.prepare(`
    UPDATE conversation_context_packets
    SET consumed_message_id = ?, consumed_request_id = ?, consumed_at = ?
    WHERE id = ?
      AND target_conversation_id = ?
      AND consumed_message_id IS NULL
  `);
  for (const packetId of ids) {
    const result = claim.run(
      input.messageId,
      input.requestId,
      input.consumedAt,
      packetId,
      input.targetConversationId,
    );
    if (result.changes !== 1) {
      throw new Error(
        "A selected chat context was removed, already sent, or belongs to another chat.",
      );
    }
  }
}

export class ConversationContextPacketRepository {
  constructor(
    private readonly context: ConversationContextPacketPersistenceContext,
  ) {}

  create(input: CreateConversationContextPacketInput): ConversationContextPacket {
    if (input.sourceConversationId === input.targetConversationId) {
      throw new Error("Choose another chat as the context source.");
    }
    const messageIds = [...input.sourceMessageIds];
    if (
      messageIds.length < 1
      || messageIds.length > MAX_CONVERSATION_CONTEXT_MESSAGES
      || new Set(messageIds).size !== messageIds.length
    ) {
      throw new Error(`Select between 1 and ${MAX_CONVERSATION_CONTEXT_MESSAGES} unique messages.`);
    }
    const source = this.context.requireConversation(input.sourceConversationId);
    const target = this.context.requireConversation(input.targetConversationId);
    const sourceProject = this.context.requireProject(source.project_id);
    this.context.requireProject(target.project_id);
    const sourcePath = normalizeIdentityPath(resolve(
      this.context.conversationPath(source.id),
    ));
    const targetPath = normalizeIdentityPath(resolve(
      this.context.conversationPath(target.id),
    ));
    const workspaceRelation = sourcePath === targetPath
      ? "same-workspace" as const
      : "different-workspace" as const;
    if (
      workspaceRelation === "different-workspace"
      && !input.acknowledgedWorkspaceDifference
    ) {
      throw new Error(
        "Confirm that this context comes from a different project or worktree.",
      );
    }
    const draftCount = this.context.database.prepare(`
      SELECT COUNT(*) AS count
      FROM conversation_context_packets
      WHERE target_conversation_id = ? AND consumed_message_id IS NULL
    `).get(target.id) as { count: number };
    if (draftCount.count >= MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN) {
      throw new Error(
        "Send or remove one of the chat context packets already attached to this draft.",
      );
    }
    const placeholders = messageIds.map(() => "?").join(", ");
    const rows = this.context.database.prepare(`
      SELECT ${MESSAGE_PROJECTION_COLUMNS}
      FROM messages
      WHERE messages.conversation_id = ?
        AND messages.id IN (${placeholders})
        AND messages.role IN ('user', 'assistant')
      ORDER BY messages.created_at ASC, messages.id ASC
    `).all(source.id, ...messageIds) as MessageRow[];
    if (rows.length !== messageIds.length) {
      throw new Error(
        "Only visible user and assistant messages from the selected source chat can be shared.",
      );
    }
    const excerpts: ConversationContextExcerpt[] = [];
    const perExcerptBudget = Math.min(
      MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES,
      Math.floor(MAX_CONVERSATION_CONTEXT_TOTAL_BYTES / rows.length),
    );
    for (const row of rows) {
      const excerpt = scrubAndBoundExcerpt(row, perExcerptBudget);
      const bytes = byteLength(excerpt.content);
      if (bytes < 1 || bytes > perExcerptBudget) {
        throw new Error("The selected chat context exceeds the shared size limit.");
      }
      excerpts.push(excerpt);
    }
    const noteSource = input.note?.trim();
    const note = noteSource
      ? truncateUtf8(
          boundedSubagentText(noteSource, noteSource.length) ?? "",
          MAX_CONVERSATION_CONTEXT_NOTE_BYTES,
        ).text || null
      : null;
    const now = new Date().toISOString();
    const id = randomUUID();
    const excerptsJson = JSON.stringify(excerpts);
    const characterCount = excerpts.reduce(
      (total, excerpt) => total + excerpt.content.length,
      0,
    );
    this.context.database.prepare(`
      INSERT INTO conversation_context_packets (
        id, source_conversation_id, target_conversation_id,
        source_project_id, target_project_id,
        source_conversation_title, source_project_name,
        source_workspace_label, target_workspace_label, workspace_relation,
        note, excerpts_json, message_count, character_count, created_at,
        consumed_message_id, consumed_request_id, consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
    `).run(
      id,
      source.id,
      target.id,
      source.project_id,
      target.project_id,
      scrubMetadata(source.title, "Source chat", 120),
      scrubMetadata(sourceProject.name, "Source project", 80),
      scrubMetadata(workspaceLabel(source), "Source workspace", 280),
      scrubMetadata(workspaceLabel(target), "Target workspace", 280),
      workspaceRelation,
      note,
      excerptsJson,
      excerpts.length,
      characterCount,
      now,
    );
    return this.get(id, target.id);
  }

  targetConversationIdsForSource(sourceConversationId: string): string[] {
    this.context.requireConversation(sourceConversationId);
    const rows = this.context.database.prepare(`
      SELECT DISTINCT target_conversation_id
      FROM conversation_context_packets
      WHERE source_conversation_id = ?
      ORDER BY target_conversation_id ASC
    `).all(sourceConversationId) as Array<{ target_conversation_id: string }>;
    return rows.map(({ target_conversation_id }) => target_conversation_id);
  }

  list(targetConversationId: string): ConversationContextPacketSummary[] {
    this.context.requireConversation(targetConversationId);
    const rows = this.context.database.prepare(`
      SELECT packet.*,
        EXISTS(
          SELECT 1 FROM conversations source
          WHERE source.id = packet.source_conversation_id
        ) AS source_available
      FROM conversation_context_packets packet
      WHERE packet.target_conversation_id = ?
      ORDER BY packet.created_at ASC, packet.id ASC
    `).all(targetConversationId) as Array<ConversationContextPacketRow & {
      source_available: 0 | 1;
    }>;
    return rows.map((row) => summaryFromPacket(
      packetFromRow(row, row.source_available === 1),
    ));
  }

  get(packetId: string, targetConversationId: string): ConversationContextPacket {
    this.context.requireConversation(targetConversationId);
    const row = this.context.database.prepare(`
      SELECT packet.*,
        EXISTS(
          SELECT 1 FROM conversations source
          WHERE source.id = packet.source_conversation_id
        ) AS source_available
      FROM conversation_context_packets packet
      WHERE packet.id = ? AND packet.target_conversation_id = ?
    `).get(packetId, targetConversationId) as
      | ConversationContextPacketRow & { source_available: 0 | 1 }
      | undefined;
    if (!row) throw new Error("The selected chat context is unavailable.");
    return packetFromRow(row, row.source_available === 1);
  }

  deleteDraft(packetId: string, targetConversationId: string): void {
    const packet = this.get(packetId, targetConversationId);
    if (packet.consumedMessageId) {
      throw new Error("Context already attached to a sent request cannot be removed.");
    }
    const result = this.context.database.prepare(`
      DELETE FROM conversation_context_packets
      WHERE id = ? AND target_conversation_id = ? AND consumed_message_id IS NULL
    `).run(packetId, targetConversationId);
    if (result.changes !== 1) {
      throw new Error("The selected chat context is no longer removable.");
    }
  }

  sourceTranscript(
    sourceConversationId: string,
    targetConversationId: string,
  ): ConversationContextSourceTranscript {
    if (sourceConversationId === targetConversationId) {
      throw new Error("Choose another chat as the context source.");
    }
    const source = this.context.requireConversation(sourceConversationId);
    const target = this.context.requireConversation(targetConversationId);
    const project = this.context.requireProject(source.project_id);
    this.context.requireProject(target.project_id);
    const sourcePath = normalizeIdentityPath(resolve(
      this.context.conversationPath(source.id),
    ));
    const targetPath = normalizeIdentityPath(resolve(
      this.context.conversationPath(target.id),
    ));
    const rows = this.context.database.prepare(`
      SELECT ${MESSAGE_PROJECTION_COLUMNS}
      FROM messages
      WHERE messages.id IN (
        SELECT id FROM messages
        WHERE conversation_id = ? AND role IN ('user', 'assistant')
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      )
      ORDER BY messages.created_at ASC, messages.id ASC
    `).all(
      source.id,
      MAX_CONVERSATION_CONTEXT_SOURCE_MESSAGES,
    ) as MessageRow[];
    return {
      conversationId: source.id,
      projectId: source.project_id,
      conversationTitle: source.title,
      projectName: project.name,
      workspaceLabel: workspaceLabel(source),
      targetConversationId: target.id,
      targetProjectId: target.project_id,
      targetWorkspaceLabel: workspaceLabel(target),
      workspaceRelation: sourcePath === targetPath
        ? "same-workspace"
        : "different-workspace",
      messages: rows.map((row) => scrubAndBoundExcerpt(row)),
    };
  }

  materialize(
    targetConversationId: string,
    packetIds: readonly string[],
  ): MaterializedConversationContext[] {
    const ids = uniquePacketIds(packetIds);
    return ids.map((id) => {
      const packet = this.get(id, targetConversationId);
      if (packet.consumedMessageId) {
        throw new Error("A selected chat context has already been sent.");
      }
      const content = JSON.stringify({
        version: 1,
        kind: "inertia-conversation-context",
        packetId: packet.id,
        source: {
          conversationId: packet.sourceConversationId,
          conversationTitle: packet.sourceConversationTitle,
          projectId: packet.sourceProjectId,
          projectName: packet.sourceProjectName,
          workspaceLabel: packet.sourceWorkspaceLabel,
          capturedAt: packet.createdAt,
        },
        relationToTarget: packet.workspaceRelation,
        note: packet.note,
        excerpts: packet.excerpts,
      });
      return {
        packetId: packet.id,
        label: `Chat context · ${packet.sourceConversationTitle} · ${packet.messageCount} ${packet.messageCount === 1 ? "message" : "messages"}`,
        content,
      };
    });
  }

  replayAcceptance(
    requestId: string,
    targetConversationId: string,
    packetIds: readonly string[],
  ): ConversationContextReplay | null {
    const ids = uniquePacketIds(packetIds);
    const rows = this.context.database.prepare(`
      SELECT id, consumed_message_id
      FROM conversation_context_packets
      WHERE target_conversation_id = ?
        AND consumed_request_id = ?
      ORDER BY id ASC
    `).all(targetConversationId, requestId) as Array<{
      id: string;
      consumed_message_id: string;
    }>;
    if (rows.length === 0) return null;
    if (
      rows.length !== ids.length
      || rows.some(({ id }) => !ids.includes(id))
      || new Set(rows.map((row) => row.consumed_message_id)).size !== 1
    ) {
      throw new Error("The retried chat context request is inconsistent.");
    }
    const userMessageId = rows[0]!.consumed_message_id;
    const turn = this.context.database.prepare(`
      SELECT id FROM agent_turns
      WHERE conversation_id = ? AND user_message_id = ?
    `).get(targetConversationId, userMessageId) as { id: string } | undefined;
    if (!turn) {
      // Provider-disabled fixtures have no turn. They still cannot duplicate
      // the consumed packet; callers return request.ok for that route.
      return { kind: "transcript-only" };
    }
    return {
      kind: "message.accepted",
      conversationId: targetConversationId,
      turnId: turn.id,
      userMessageId,
      disposition: "new-turn",
    };
  }
}
