import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type Database from "better-sqlite3";

import {
  MAX_CONVERSATION_CONTEXT_ATTACHMENTS_PER_MESSAGE,
  MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES,
  MAX_CONVERSATION_CONTEXT_EXCERPTS_JSON_BYTES,
  MAX_CONVERSATION_CONTEXT_MESSAGES,
  MAX_CONVERSATION_CONTEXT_NOTE_BYTES,
  MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN,
  MAX_CONVERSATION_CONTEXT_SOURCE_MESSAGES,
  MAX_CONVERSATION_CONTEXT_TOTAL_BYTES,
  MAX_CONVERSATION_CONTEXT_TURN_BYTES,
  type ConversationContextAttachmentReference,
  type ConversationContextExcerpt,
  type ConversationContextPacket,
  type ConversationContextPacketSummary,
  type ConversationContextSourceTranscript,
  type ChatAttachment,
  type ChatMessage,
  type MaterializedConversationContext,
  type MessageSendAcceptance,
} from "../../shared/contracts";
import { normalizeIdentityPath } from "../project-identity";
import { boundedSubagentText } from "../provider/subagent-trace";
import { neutralizeUntrustedAgentText, truncateUtf8 } from "../runtime/untrusted-agent-text";
import { parseStoredAttachments as parseAttachments } from "./codecs";
import type { ConversationRow, ProjectRow } from "./rows";
import {
  conversationContextOpeningRow,
  conversationContextSourceRows,
  type ConversationContextSourceRow,
} from "./conversation-context-source";
import {
  CONVERSATION_CONTEXT_TRANSPORT_VERSION,
  allocateConversationContextBudgets,
  conversationContextTransportBudget,
  prepareConversationContextPacket,
  prepareLegacyConversationContextPacket,
  type ConversationContextDelivery,
  type ConversationContextTransport,
} from "./conversation-context-transport";
import type { CreateMessageOptions } from "./types";

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
  dropped_message_count: number;
  transport_version: 1 | 2;
  delivered_budget_bytes: number | null;
  delivered_message_count: number | null;
  delivered_character_count: number | null;
  delivered_omitted_count: number | null;
}

type ConversationContextPacketListRow = Omit<ConversationContextPacketRow, "excerpts_json"> & {
  excerpts_json: string | null;
  source_available: 0 | 1;
};

const AGENT_CONTEXT_RESULT_BUDGET_BYTES = 28 * 1024;

export type ConversationContextReplay =
  | MessageSendAcceptance
  | { kind: "transcript-only" };

export interface CreateConversationContextPacketInput {
  sourceConversationId: string;
  targetConversationId: string;
  sourceMessageIds?: readonly string[];
  note?: string;
  acknowledgedWorkspaceDifference: boolean;
}

export type AgentConversationContextRequestStatus =
  | "selection-pending"
  | "completed"
  | "denied"
  | "cancelled"
  | "expired"
  | "interrupted"
  | "failed";

export interface AgentConversationContextRequestRecord {
  id: string;
  targetConversationId: string;
  targetTurnId: string;
  targetUserMessageId: string;
  targetRunId: string;
  sourceHarnessId: string;
  requestedSourceConversationId: string | null;
  selectedSourceConversationId: string | null;
  toolCallIdHash: string;
  requestFingerprint: string;
  status: AgentConversationContextRequestStatus;
  packetId: string | null;
  resultJson: string | null;
  failureMessage: string | null;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
}

interface AgentConversationContextRequestRow {
  id: string;
  target_conversation_id: string;
  target_turn_id: string;
  target_user_message_id: string;
  target_run_id: string;
  source_harness_id: string;
  requested_source_conversation_id: string | null;
  selected_source_conversation_id: string | null;
  tool_call_id_hash: string;
  request_fingerprint: string;
  status: AgentConversationContextRequestStatus;
  packet_id: string | null;
  result_json: string | null;
  failure_message: string | null;
  created_at: string;
  expires_at: string;
  updated_at: string;
}

interface ConversationContextPacketPersistenceContext {
  database: Database.Database;
  conversationPath(conversationId: string): string;
  requireConversation(conversationId: string): ConversationRow;
  requireProject(projectId: string): ProjectRow;
  createUserMessage(
    conversationId: string,
    content: string,
    attachments: ChatAttachment[],
    options?: CreateMessageOptions,
  ): ChatMessage;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

const ATTACHMENT_REFERENCE_KEYS = ["id", "mimeType", "name", "size"]
  .sort()
  .join("\0");

function attachmentReferences(
  attachmentsJson: string,
): ConversationContextAttachmentReference[] {
  return parseAttachments(attachmentsJson)
    .slice(0, MAX_CONVERSATION_CONTEXT_ATTACHMENTS_PER_MESSAGE)
    .map((attachment) => ({
      id: attachment.id,
      name: scrubMetadata(attachment.name, "Attachment", 200),
      mimeType: attachment.mimeType,
      size: attachment.size,
    }));
}

function isAttachmentReferenceList(value: unknown): boolean {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > MAX_CONVERSATION_CONTEXT_ATTACHMENTS_PER_MESSAGE
  ) return false;
  const ids = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const attachment = entry as Record<string, unknown>;
    if (
      Object.keys(attachment).sort().join("\0") !== ATTACHMENT_REFERENCE_KEYS
      || typeof attachment.id !== "string"
      || attachment.id.length < 1
      || ids.has(attachment.id)
      || typeof attachment.name !== "string"
      || attachment.name.length < 1
      || typeof attachment.mimeType !== "string"
      || attachment.mimeType.length < 1
      || typeof attachment.size !== "number"
      || !Number.isSafeInteger(attachment.size)
      || attachment.size < 1
    ) return false;
    ids.add(attachment.id);
  }
  return true;
}

const SHORTENED_MIDDLE = "…\n\n[middle of message omitted]\n\n";

function cleanExcerptText(value: string): string | null {
  const scrubbed = boundedSubagentText(value, value.length);
  return scrubbed === null
    ? null
    : neutralizeUntrustedAgentText(scrubbed.replace(/\r\n?/gu, "\n"));
}

function tailUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let start = bytes.length - maximumBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  const tail = bytes.subarray(start).toString("utf8");
  const lineEnd = tail.indexOf("\n");
  if (lineEnd !== -1 && lineEnd < tail.length / 2) return tail.slice(lineEnd + 1);
  const space = tail.search(/\s/u);
  return space !== -1 && space < tail.length / 2 ? tail.slice(space + 1) : tail;
}

function boundExcerptText(head: string, tail: string, maximumBytes: number): string {
  const available = maximumBytes - byteLength(SHORTENED_MIDDLE);
  const keptTail = tail.trim()
    ? neutralizeUntrustedAgentText(tailUtf8(tail, Math.floor(available * 0.4)))
    : "";
  if (!keptTail.trim()) return truncateUtf8(head, maximumBytes).text;
  let headBytes = available - byteLength(keptTail);
  while (headBytes > 0) {
    const candidate = neutralizeUntrustedAgentText(
      `${truncateUtf8(head, headBytes).text}${SHORTENED_MIDDLE}${keptTail}`,
    );
    const overflow = byteLength(candidate) - maximumBytes;
    if (overflow <= 0) return candidate;
    headBytes -= overflow;
  }
  return truncateUtf8(head, maximumBytes).text;
}

/**
 * Defense-in-depth only. The user previews the exact bounded copy because any
 * visible chat prose may legitimately contain material no pattern can detect.
 * Media stays in its source chat; only its durable identity travels.
 */
function scrubAndBoundExcerpt(
  row: ConversationContextSourceRow,
  remainingBytes = MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES,
): ConversationContextExcerpt {
  const limit = Math.min(MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES, remainingBytes);
  // Redact, then neutralize instruction-shaped text another model may have
  // written, then bound: neutralizing grows the text, so the cap comes last.
  const head = cleanExcerptText(row.content);
  const bounded = head === null
    ? truncateUtf8(
        row.contentTruncated ? "[Message excerpt omitted]" : "[Empty message omitted]",
        limit,
      )
    : !row.contentTruncated && byteLength(head) <= limit
      ? { text: head, truncated: false }
      : {
          text: boundExcerptText(
            head,
            row.contentTruncated ? cleanExcerptText(row.tail ?? "") ?? "" : head,
            limit,
          ),
          truncated: true,
        };
  const attachments = attachmentReferences(row.attachments_json);
  return {
    sourceMessageId: row.id,
    sourceTurnId: row.turn_id,
    role: row.role as "user" | "assistant",
    content: bounded.text,
    truncated: row.contentTruncated || bounded.truncated,
    createdAt: row.created_at,
    ...(attachments.length > 0 ? { attachments } : {}),
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
    const expectedKeys = [
      "content",
      "createdAt",
      "role",
      "sourceMessageId",
      "sourceTurnId",
      "truncated",
      ...(excerpt.attachments === undefined ? [] : ["attachments"]),
    ];
    if (
      keys.join("\0") !== expectedKeys.sort().join("\0")
      || (
        excerpt.attachments !== undefined
        && !isAttachmentReferenceList(excerpt.attachments)
      )
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

function summaryFromRow(
  row: Omit<ConversationContextPacketRow, "excerpts_json">,
  sourceAvailable: boolean,
): ConversationContextPacketSummary {
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
    droppedMessageCount: row.dropped_message_count,
    createdAt: row.created_at,
    consumedMessageId: row.consumed_message_id,
    consumedAt: row.consumed_at,
    sourceState: sourceAvailable ? "available" : "deleted",
  };
}

function packetFromRow(
  row: ConversationContextPacketRow,
  sourceAvailable: boolean,
): ConversationContextPacket {
  return { ...summaryFromRow(row, sourceAvailable), excerpts: parseExcerpts(row) };
}

function deliveredSummary(
  row: Omit<ConversationContextPacketRow, "excerpts_json">,
  sourceAvailable: boolean,
): ConversationContextPacketSummary {
  if (
    row.delivered_message_count === null
    || row.delivered_character_count === null
    || row.delivered_omitted_count === null
  ) {
    throw new Error("The saved chat context no longer matches its provenance.");
  }
  return {
    ...summaryFromRow(row, sourceAvailable),
    messageCount: row.delivered_message_count,
    characterCount: row.delivered_character_count,
    droppedMessageCount: row.delivered_omitted_count,
  };
}

function deliveryFor(
  packet: ConversationContextPacket,
  budgetBytes: number,
): ConversationContextDelivery {
  return {
    packetId: packet.id,
    budgetBytes,
    messageCount: packet.messageCount,
    characterCount: packet.characterCount,
    omittedMessageCount: packet.droppedMessageCount,
  };
}

const PACKET_SUMMARY_COLUMNS = `
  packet.id, packet.source_conversation_id, packet.target_conversation_id,
  packet.source_project_id, packet.target_project_id,
  packet.source_conversation_title, packet.source_project_name,
  packet.source_workspace_label, packet.target_workspace_label,
  packet.workspace_relation, packet.note, packet.message_count,
  packet.character_count, packet.created_at, packet.consumed_message_id,
  packet.consumed_request_id, packet.consumed_at, packet.dropped_message_count,
  packet.transport_version, packet.delivered_budget_bytes,
  packet.delivered_message_count, packet.delivered_character_count,
  packet.delivered_omitted_count`;

function summaryFromPacket(
  packet: ConversationContextPacket,
): ConversationContextPacketSummary {
  const { excerpts: _excerpts, omissions: _omissions, ...summary } = packet;
  return summary;
}

function agentRequestFromRow(
  row: AgentConversationContextRequestRow,
): AgentConversationContextRequestRecord {
  return {
    id: row.id,
    targetConversationId: row.target_conversation_id,
    targetTurnId: row.target_turn_id,
    targetUserMessageId: row.target_user_message_id,
    targetRunId: row.target_run_id,
    sourceHarnessId: row.source_harness_id,
    requestedSourceConversationId: row.requested_source_conversation_id,
    selectedSourceConversationId: row.selected_source_conversation_id,
    toolCallIdHash: row.tool_call_id_hash,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    packetId: row.packet_id,
    resultJson: row.result_json,
    failureMessage: row.failure_message,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  };
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

// Titles and branch-derived labels can be authored by another agent run.
// Neutralize after collapsing whitespace, which could otherwise form a tag.
function scrubMetadata(value: string, fallback: string, maxLength: number): string {
  const collapsed = (boundedSubagentText(value, value.length) ?? fallback)
    .replace(/\s+/gu, " ")
    .trim();
  return neutralizeUntrustedAgentText(collapsed).slice(0, maxLength) || fallback;
}

function uniquePacketIds(ids: readonly string[]): string[] {
  if (
    ids.length < 1
    || ids.length > MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN
    || new Set(ids).size !== ids.length
  ) {
    throw new Error(
      `Select between 1 and ${MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN} unique chat context packets.`,
    );
  }
  return [...ids];
}

export function claimConversationContextPackets(
  database: Database.Database,
  input: {
    packetIds: readonly string[];
    deliveries: readonly ConversationContextDelivery[];
    targetConversationId: string;
    messageId: string;
    requestId: string;
    consumedAt: string;
  },
): void {
  const ids = uniquePacketIds(input.packetIds);
  const deliveries = new Map(input.deliveries.map((delivery) => [delivery.packetId, delivery]));
  if (deliveries.size !== ids.length || ids.some((id) => !deliveries.has(id))) {
    throw new Error("Every selected chat context needs its delivered selection.");
  }
  const claim = database.prepare(`
    UPDATE conversation_context_packets
    SET consumed_message_id = ?, consumed_request_id = ?, consumed_at = ?,
      delivered_budget_bytes = ?, delivered_message_count = ?,
      delivered_character_count = ?, delivered_omitted_count = ?
    WHERE id = ?
      AND target_conversation_id = ?
      AND consumed_message_id IS NULL
      AND transport_version = ${CONVERSATION_CONTEXT_TRANSPORT_VERSION}
  `);
  for (const packetId of ids) {
    const delivery = deliveries.get(packetId)!;
    const result = claim.run(
      input.messageId,
      input.requestId,
      input.consumedAt,
      delivery.budgetBytes,
      delivery.messageCount,
      delivery.characterCount,
      delivery.omittedMessageCount,
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
    return this.insert(input, null);
  }

  createUserMessageWithPackets(input: {
    conversationId: string;
    content: string;
    attachments: ChatAttachment[];
    packetIds: readonly string[];
    requestId: string;
    options?: CreateMessageOptions;
  }): ChatMessage {
    return this.context.database.transaction(() => {
      const message = this.context.createUserMessage(
        input.conversationId,
        input.content,
        input.attachments,
        input.options,
      );
      claimConversationContextPackets(this.context.database, {
        packetIds: input.packetIds,
        deliveries: this.materialize(input.conversationId, input.packetIds).deliveries,
        targetConversationId: input.conversationId,
        messageId: message.id,
        requestId: input.requestId,
        consumedAt: message.createdAt,
      });
      return message;
    })();
  }

  private insert(
    input: CreateConversationContextPacketInput,
    consumption: {
      messageId: string;
      requestId: string;
      consumedAt: string;
      budgetBytes: number;
      transport: ConversationContextTransport;
    } | null,
  ): ConversationContextPacket {
    const ownConversation = input.sourceConversationId === input.targetConversationId;
    if (ownConversation && consumption) {
      throw new Error("Choose another chat as the context source.");
    }
    const selectedIds = input.sourceMessageIds
      ? [...input.sourceMessageIds]
      : null;
    if (
      selectedIds && (
        selectedIds.length < 1
        || selectedIds.length > MAX_CONVERSATION_CONTEXT_MESSAGES
        || new Set(selectedIds).size !== selectedIds.length
      )
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
    if (!consumption) {
      const drafts = this.context.database.prepare(`
        SELECT source_conversation_id
        FROM conversation_context_packets
        WHERE target_conversation_id = ? AND consumed_message_id IS NULL
      `).all(target.id) as Array<{ source_conversation_id: string }>;
      if (drafts.some(({ source_conversation_id }) => source_conversation_id === source.id)) {
        throw new Error(ownConversation
          ? "This chat is already referenced in this message."
          : "That chat is already referenced in this message.");
      }
      if (drafts.length >= MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN) {
        throw new Error(
          "Send or remove one of the chat context packets already attached to this draft.",
        );
      }
    }
    const eligibleCount = (this.context.database.prepare(`
      SELECT COUNT(*) AS count FROM messages
      WHERE conversation_id = ? AND role IN ('user', 'assistant')
        ${selectedIds ? `AND id IN (${selectedIds.map(() => "?").join(", ")})` : ""}
    `).get(source.id, ...(selectedIds ?? [])) as { count: number }).count;
    if (selectedIds && eligibleCount !== selectedIds.length) {
      throw new Error(
        "Only visible user and assistant messages from the selected source chat can be shared.",
      );
    }
    if (eligibleCount < 1) {
      throw new Error("That chat has no shareable messages yet.");
    }
    const perExcerptBudget = selectedIds
      ? Math.min(
          MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES,
          Math.floor(MAX_CONVERSATION_CONTEXT_TOTAL_BYTES / eligibleCount),
        )
      : MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES;
    let retainedBytes = 0;
    let retainedJsonBytes = 2;
    const retain = (excerpt: ConversationContextExcerpt): boolean => {
      const bytes = byteLength(excerpt.content);
      const jsonBytes = byteLength(JSON.stringify(excerpt)) + 1;
      if (
        retainedBytes + bytes > MAX_CONVERSATION_CONTEXT_TOTAL_BYTES
        || retainedJsonBytes + jsonBytes > MAX_CONVERSATION_CONTEXT_EXCERPTS_JSON_BYTES
      ) return false;
      retainedBytes += bytes;
      retainedJsonBytes += jsonBytes;
      return true;
    };
    const openingRow = selectedIds
      ? null
      : conversationContextOpeningRow(this.context.database, source.id);
    let opening = openingRow ? scrubAndBoundExcerpt(openingRow, perExcerptBudget) : null;
    if (opening && !retain(opening)) opening = null;
    const window: ConversationContextExcerpt[] = [];
    for (const row of conversationContextSourceRows(
      this.context.database, source.id, MAX_CONVERSATION_CONTEXT_MESSAGES,
      selectedIds ?? undefined,
    )) {
      if (window.length + (opening ? 1 : 0) >= MAX_CONVERSATION_CONTEXT_MESSAGES) break;
      if (opening && row.id === opening.sourceMessageId) {
        window.push(opening);
        opening = null;
        continue;
      }
      const excerpt = scrubAndBoundExcerpt(row, perExcerptBudget);
      if (!retain(excerpt)) break;
      window.push(excerpt);
    }
    const excerpts = [...(opening ? [opening] : []), ...window.reverse()];
    if (excerpts.length < 1) {
      throw new Error("The selected chat context exceeds the shared size limit.");
    }
    const droppedMessageCount = Math.min(
      Math.max(eligibleCount - excerpts.length, 0),
      1_000_000,
    );
    const noteSource = input.note?.trim();
    const note = noteSource
      ? truncateUtf8(
          boundedSubagentText(noteSource, noteSource.length) ?? "",
          MAX_CONVERSATION_CONTEXT_NOTE_BYTES,
        ).text || null
      : null;
    const now = consumption?.consumedAt ?? new Date().toISOString();
    const id = randomUUID();
    const excerptsJson = JSON.stringify(excerpts);
    if (byteLength(excerptsJson) > MAX_CONVERSATION_CONTEXT_EXCERPTS_JSON_BYTES) {
      throw new Error("The selected chat context exceeds the shared size limit.");
    }
    const characterCount = excerpts.reduce(
      (total, excerpt) => total + excerpt.content.length,
      0,
    );
    const packet: ConversationContextPacket = {
      id,
      sourceConversationId: source.id,
      targetConversationId: target.id,
      sourceProjectId: source.project_id,
      targetProjectId: target.project_id,
      sourceConversationTitle: scrubMetadata(source.title, "Source chat", 120),
      sourceProjectName: scrubMetadata(sourceProject.name, "Source project", 80),
      sourceWorkspaceLabel: scrubMetadata(workspaceLabel(source), "Source workspace", 280),
      targetWorkspaceLabel: scrubMetadata(workspaceLabel(target), "Target workspace", 280),
      workspaceRelation,
      note,
      messageCount: excerpts.length,
      characterCount,
      droppedMessageCount,
      createdAt: now,
      consumedMessageId: consumption?.messageId ?? null,
      consumedAt: consumption?.consumedAt ?? null,
      sourceState: "available",
      excerpts,
    };
    const delivery = consumption
      ? deliveryFor(
          prepareConversationContextPacket(
            packet,
            consumption.budgetBytes,
            consumption.transport,
          ).packet,
          consumption.budgetBytes,
        )
      : null;
    this.context.database.prepare(`
      INSERT INTO conversation_context_packets (
        id, source_conversation_id, target_conversation_id,
        source_project_id, target_project_id,
        source_conversation_title, source_project_name,
        source_workspace_label, target_workspace_label, workspace_relation,
        note, excerpts_json, message_count, character_count, created_at,
        consumed_message_id, consumed_request_id, consumed_at,
        dropped_message_count, transport_version, delivered_budget_bytes,
        delivered_message_count, delivered_character_count,
        delivered_omitted_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      packet.sourceConversationId,
      packet.targetConversationId,
      packet.sourceProjectId,
      packet.targetProjectId,
      packet.sourceConversationTitle,
      packet.sourceProjectName,
      packet.sourceWorkspaceLabel,
      packet.targetWorkspaceLabel,
      workspaceRelation,
      note,
      excerptsJson,
      excerpts.length,
      characterCount,
      now,
      consumption?.messageId ?? null,
      consumption?.requestId ?? null,
      consumption?.consumedAt ?? null,
      droppedMessageCount,
      CONVERSATION_CONTEXT_TRANSPORT_VERSION,
      delivery?.budgetBytes ?? null,
      delivery?.messageCount ?? null,
      delivery?.characterCount ?? null,
      delivery?.omittedMessageCount ?? null,
    );
    return this.get(id, target.id);
  }

  recoverInterruptedAgentRequests(now = new Date().toISOString()): number {
    return this.context.database.prepare(`
      UPDATE agent_context_requests
      SET status = 'interrupted',
          failure_message = 'The host restarted before context selection settled.',
          updated_at = ?
      WHERE status = 'selection-pending'
    `).run(now).changes;
  }

  agentRequest(id: string): AgentConversationContextRequestRecord | null {
    const row = this.context.database.prepare(`
      SELECT * FROM agent_context_requests WHERE id = ?
    `).get(id) as AgentConversationContextRequestRow | undefined;
    return row ? agentRequestFromRow(row) : null;
  }

  reserveAgentRequest(input: {
    id: string;
    targetConversationId: string;
    targetTurnId: string;
    targetUserMessageId: string;
    targetRunId: string;
    sourceHarnessId: string;
    requestedSourceConversationId: string | null;
    toolCallIdHash: string;
    requestFingerprint: string;
    now: string;
    expiresAt: string;
  }): { kind: "reserved" | "replay" | "conflict" | "limit";
    request: AgentConversationContextRequestRecord | null } {
    return this.context.database.transaction(() => {
      const existingRow = this.context.database.prepare(`
        SELECT * FROM agent_context_requests
        WHERE target_turn_id = ? AND tool_call_id_hash = ?
      `).get(input.targetTurnId, input.toolCallIdHash) as
        | AgentConversationContextRequestRow
        | undefined;
      if (existingRow) {
        const existing = agentRequestFromRow(existingRow);
        return {
          kind: existing.requestFingerprint === input.requestFingerprint
            ? "replay" as const
            : "conflict" as const,
          request: existing,
        };
      }
      const pending = this.context.database.prepare(`
        SELECT COUNT(*) AS count FROM agent_context_requests
        WHERE target_turn_id = ?
      `).get(input.targetTurnId) as { count: number };
      if (pending.count >= 4) return { kind: "limit" as const, request: null };
      this.context.requireConversation(input.targetConversationId);
      if (input.requestedSourceConversationId) {
        this.context.requireConversation(input.requestedSourceConversationId);
        if (input.requestedSourceConversationId === input.targetConversationId) {
          throw new Error("Choose another chat as the context source.");
        }
      }
      const turnIdentity = this.context.database.prepare(`
        SELECT 1
        FROM agent_turns turn
        JOIN messages message ON message.id = turn.user_message_id
        WHERE turn.id = ?
          AND turn.conversation_id = ?
          AND turn.user_message_id = ?
          AND turn.run_id = ?
          AND message.conversation_id = turn.conversation_id
          AND message.role = 'user'
      `).get(
        input.targetTurnId,
        input.targetConversationId,
        input.targetUserMessageId,
        input.targetRunId,
      );
      if (!turnIdentity) {
        throw new Error("The context request no longer matches its target turn.");
      }
      this.context.database.prepare(`
        INSERT INTO agent_context_requests (
          id, target_conversation_id, target_turn_id, target_user_message_id,
          target_run_id, source_harness_id, requested_source_conversation_id,
          selected_source_conversation_id, tool_call_id_hash,
          request_fingerprint, status, packet_id, result_json,
          failure_message, created_at, expires_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'selection-pending',
          NULL, NULL, NULL, ?, ?, ?)
      `).run(
        input.id,
        input.targetConversationId,
        input.targetTurnId,
        input.targetUserMessageId,
        input.targetRunId,
        input.sourceHarnessId,
        input.requestedSourceConversationId,
        input.toolCallIdHash,
        input.requestFingerprint,
        input.now,
        input.expiresAt,
        input.now,
      );
      return { kind: "reserved" as const, request: this.agentRequest(input.id)! };
    })();
  }

  finishAgentRequest(
    id: string,
    status: Exclude<AgentConversationContextRequestStatus, "selection-pending" | "completed">,
    failureMessage: string,
    now: string,
  ): void {
    const result = this.context.database.prepare(`
      UPDATE agent_context_requests
      SET status = ?, failure_message = ?, updated_at = ?
      WHERE id = ? AND status = 'selection-pending'
    `).run(status, failureMessage.slice(0, 1_000), now, id);
    if (result.changes !== 1) {
      throw new Error("The context request no longer owns its pending state.");
    }
  }

  completeAgentRequest(input: CreateConversationContextPacketInput & {
    requestId: string;
    targetTurnId: string;
    targetRunId: string;
    targetUserMessageId: string;
    toolCallIdHash: string;
    completedAt: string;
  }): { packet: ConversationContextPacket; resultJson: string } {
    return this.context.database.transaction(() => {
      const request = this.agentRequest(input.requestId);
      if (
        !request
        || request.status !== "selection-pending"
        || request.targetConversationId !== input.targetConversationId
        || request.targetTurnId !== input.targetTurnId
        || request.targetRunId !== input.targetRunId
        || request.targetUserMessageId !== input.targetUserMessageId
        || request.toolCallIdHash !== input.toolCallIdHash
        || (
          request.requestedSourceConversationId !== null
          && request.requestedSourceConversationId !== input.sourceConversationId
        )
      ) {
        throw new Error("The approved context request no longer owns this operation.");
      }
      const original = this.insert(input, {
        messageId: input.targetUserMessageId,
        requestId: input.requestId,
        consumedAt: input.completedAt,
        budgetBytes: AGENT_CONTEXT_RESULT_BUDGET_BYTES,
        transport: "tool-result",
      });
      const { packet, blocks } = prepareConversationContextPacket(
        original,
        AGENT_CONTEXT_RESULT_BUDGET_BYTES,
        "tool-result",
      );
      const resultJson = JSON.stringify({
        context: blocks.map((block) => JSON.parse(block.content) as unknown),
      });
      if (byteLength(resultJson) > 32 * 1024) {
        throw new Error("The selected context exceeds the host-tool result limit.");
      }
      const updated = this.context.database.prepare(`
        UPDATE agent_context_requests
        SET status = 'completed', selected_source_conversation_id = ?,
          packet_id = ?, result_json = ?, failure_message = NULL, updated_at = ?
        WHERE id = ? AND status = 'selection-pending'
      `).run(
        input.sourceConversationId,
        packet.id,
        resultJson,
        input.completedAt,
        input.requestId,
      );
      if (updated.changes !== 1) {
        throw new Error("The context request completion lost its pending authority.");
      }
      return { packet, resultJson };
    })();
  }

  targetConversationIdsForSource(sourceConversationId: string): string[] {
    this.context.requireConversation(sourceConversationId);
    const rows = this.context.database.prepare(`
      SELECT DISTINCT target_conversation_id
      FROM conversation_context_packets
      WHERE source_conversation_id = ?
        AND target_conversation_id <> source_conversation_id
      ORDER BY target_conversation_id ASC
    `).all(sourceConversationId) as Array<{ target_conversation_id: string }>;
    return rows.map(({ target_conversation_id }) => target_conversation_id);
  }

  list(targetConversationId: string, messageIds?: string[]): ConversationContextPacketSummary[] {
    this.context.requireConversation(targetConversationId);
    const rows = this.context.database.prepare(`
      SELECT ${PACKET_SUMMARY_COLUMNS},
        CASE WHEN packet.transport_version = 1 OR packet.consumed_message_id IS NULL
          THEN packet.excerpts_json END AS excerpts_json,
        EXISTS(
          SELECT 1 FROM conversations source
          WHERE source.id = packet.source_conversation_id
        ) AS source_available
      FROM conversation_context_packets packet
      WHERE packet.target_conversation_id = ?
        ${messageIds ? `AND (packet.consumed_message_id IS NULL OR packet.consumed_message_id IN (${messageIds.map(() => "?").join(",") || "NULL"}))` : ""}
      ORDER BY packet.created_at ASC, packet.id ASC
    `).all(targetConversationId, ...(messageIds ?? [])) as ConversationContextPacketListRow[];
    const legacyCohorts = new Map<string | null, number>();
    for (const row of rows) {
      if (row.transport_version !== 1) continue;
      legacyCohorts.set(row.consumed_request_id,
        (legacyCohorts.get(row.consumed_request_id) ?? 0) + 1);
    }
    const agentPackets = new Set((this.context.database.prepare(`
      SELECT packet_id FROM agent_context_requests
      WHERE target_conversation_id = ? AND status = 'completed'
    `).all(targetConversationId) as Array<{ packet_id: string }>).map((row) => row.packet_id));
    const drafts = new Map(this.previewDrafts(rows
      .filter((row) => row.consumed_message_id === null)
      .map((row) => packetFromRow(row as ConversationContextPacketRow, row.source_available === 1)))
      .map((packet) => [packet.id, packet]));
    return rows.map((row) => {
      const draft = drafts.get(row.id);
      if (draft) return summaryFromPacket(draft);
      if (row.transport_version !== 1) return deliveredSummary(row, row.source_available === 1);
      return summaryFromPacket(prepareLegacyConversationContextPacket(
        packetFromRow(row as ConversationContextPacketRow, row.source_available === 1),
        agentPackets.has(row.id) ? AGENT_CONTEXT_RESULT_BUDGET_BYTES
          : conversationContextTransportBudget(legacyCohorts.get(row.consumed_request_id)!),
        agentPackets.has(row.id) ? "tool-result" : "prompt",
      ).packet);
    });
  }

  get(packetId: string, targetConversationId: string): ConversationContextPacket {
    const row = this.row(packetId, targetConversationId);
    return packetFromRow(row, row.source_available === 1);
  }

  preview(packetId: string, targetConversationId: string): ConversationContextPacket {
    const row = this.row(packetId, targetConversationId);
    const packet = packetFromRow(row, row.source_available === 1);
    if (row.consumed_message_id === null) {
      return this.previewDrafts(this.draftPackets(targetConversationId))
        .find(({ id }) => id === packetId)!;
    }
    const agentRequested = this.context.database.prepare(`
      SELECT 1 FROM agent_context_requests
      WHERE packet_id = ? AND target_conversation_id = ? AND status = 'completed'
    `).get(packetId, targetConversationId) !== undefined;
    if (row.transport_version !== 1) {
      const delivered = prepareConversationContextPacket(
        packet,
        row.delivered_budget_bytes ?? 0,
        agentRequested ? "tool-result" : "prompt",
      ).packet;
      const expected = deliveredSummary(row, row.source_available === 1);
      if (
        delivered.messageCount !== expected.messageCount
        || delivered.characterCount !== expected.characterCount
        || delivered.droppedMessageCount !== expected.droppedMessageCount
      ) {
        throw new Error("The saved chat context no longer matches its provenance.");
      }
      return delivered;
    }
    // Sent receipts use their immutable request cohort, never today's drafts.
    const cohort = this.context.database.prepare(`
      SELECT COUNT(*) AS count
      FROM conversation_context_packets
      WHERE target_conversation_id = ? AND consumed_request_id IS (
        SELECT consumed_request_id FROM conversation_context_packets WHERE id = ?
      )
    `).get(targetConversationId, packetId) as { count: number };
    return prepareLegacyConversationContextPacket(
      packet,
      agentRequested ? AGENT_CONTEXT_RESULT_BUDGET_BYTES : conversationContextTransportBudget(cohort.count),
      agentRequested ? "tool-result" : "prompt",
    ).packet;
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
    const messages = Array.from(conversationContextSourceRows(
      this.context.database, source.id, MAX_CONVERSATION_CONTEXT_SOURCE_MESSAGES,
    ), (row) => scrubAndBoundExcerpt(row)).reverse();
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
      messages,
    };
  }

  materialize(
    targetConversationId: string,
    packetIds: readonly string[],
    totalBytes = MAX_CONVERSATION_CONTEXT_TURN_BYTES,
  ): { blocks: MaterializedConversationContext[]; deliveries: ConversationContextDelivery[] } {
    const packets = uniquePacketIds(packetIds).map((id) => this.sendable(id, targetConversationId));
    const budgets = allocateConversationContextBudgets(packets, totalBytes);
    const prepared = packets.map((packet, index) =>
      prepareConversationContextPacket(packet, budgets[index]!));
    return {
      blocks: prepared.flatMap(({ blocks }) => blocks),
      deliveries: prepared.map(({ packet }, index) => deliveryFor(packet, budgets[index]!)),
    };
  }

  assertSendable(targetConversationId: string, packetIds: readonly string[]): void {
    for (const id of uniquePacketIds(packetIds)) this.sendable(id, targetConversationId);
  }

  private sendable(packetId: string, targetConversationId: string): ConversationContextPacket {
    const [row] = this.rows(targetConversationId, "packet.id = ? AND packet.consumed_message_id IS NULL", packetId);
    if (!row) {
      throw new Error(
        "A selected chat context was removed, already sent, or belongs to another chat.",
      );
    }
    return packetFromRow(row, row.source_available === 1);
  }

  private row(
    packetId: string,
    targetConversationId: string,
  ): ConversationContextPacketRow & { source_available: 0 | 1 } {
    const [row] = this.rows(targetConversationId, "packet.id = ?", packetId);
    if (!row) throw new Error("The selected chat context is unavailable.");
    return row;
  }

  private draftPackets(targetConversationId: string): ConversationContextPacket[] {
    return this.rows(targetConversationId, "packet.consumed_message_id IS NULL")
      .map((row) => packetFromRow(row, row.source_available === 1));
  }

  private rows(
    targetConversationId: string,
    condition: string,
    ...parameters: string[]
  ): Array<ConversationContextPacketRow & { source_available: 0 | 1 }> {
    this.context.requireConversation(targetConversationId);
    return this.context.database.prepare(`
      SELECT packet.*,
        EXISTS(
          SELECT 1 FROM conversations source
          WHERE source.id = packet.source_conversation_id
        ) AS source_available
      FROM conversation_context_packets packet
      WHERE packet.target_conversation_id = ? AND ${condition}
      ORDER BY packet.created_at ASC, packet.id ASC
    `).all(targetConversationId, ...parameters) as Array<
      ConversationContextPacketRow & { source_available: 0 | 1 }
    >;
  }

  private previewDrafts(
    drafts: readonly ConversationContextPacket[],
  ): ConversationContextPacket[] {
    const budgets = allocateConversationContextBudgets(drafts, MAX_CONVERSATION_CONTEXT_TURN_BYTES);
    return drafts.map((packet, index) =>
      prepareConversationContextPacket(packet, budgets[index]!).packet);
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
