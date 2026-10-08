import type Database from "better-sqlite3";

import {
  MAX_CONVERSATION_CONTEXT_ATTACHMENTS_PER_MESSAGE,
  MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES,
  MAX_CONVERSATION_CONTEXT_EXCERPTS_JSON_BYTES,
  MAX_CONVERSATION_CONTEXT_MESSAGES,
  MAX_CONVERSATION_CONTEXT_TOTAL_BYTES,
  MAX_CONVERSATION_CONTEXT_UPDATE_EXCERPT_BYTES,
  conversationWorkspaceLabel,
  type ConversationContextAttachmentReference,
  type ConversationContextExcerpt,
} from "../../shared/conversation-context";
import { boundedSubagentText } from "../provider/subagent-trace";
import { neutralizeUntrustedAgentText, truncateUtf8 } from "../runtime/untrusted-agent-text";
import { parseStoredAttachments as parseAttachments } from "./codecs";
import {
  CONVERSATION_CONTEXT_MESSAGE_SQL,
  continuationRouteSql,
  conversationContextOpeningRow,
  conversationContextSourceRows,
  type ContinuationRouteFilter,
  type ConversationContextSourceRow,
} from "./conversation-context-source";
import type { ConversationRow } from "./rows";
import { byteLength } from "./bounded-message-text";
import { turnContextFactsReader } from "./turn-context-facts";

const TURN_MARKER_BYTES = byteLength(`,${JSON.stringify("turn")}:${JSON.stringify("cancelled")}`);

export function conversationContextWorkspaceLabel(
  conversation: Pick<ConversationRow, "branch" | "worktree_path">,
): string {
  return conversationWorkspaceLabel({
    branch: conversation.branch,
    worktreePath: conversation.worktree_path,
  });
}

// Titles and branch-derived labels can be authored by another agent run.
// Neutralize after collapsing whitespace, which could otherwise form a tag.
export function scrubConversationContextMetadata(
  value: string,
  fallback: string,
  maxLength: number,
): string {
  const collapsed = (boundedSubagentText(value, value.length) ?? fallback)
    .replace(/\s+/gu, " ")
    .trim();
  return neutralizeUntrustedAgentText(collapsed).slice(0, maxLength) || fallback;
}

function attachmentReferences(
  attachmentsJson: string,
): ConversationContextAttachmentReference[] {
  return parseAttachments(attachmentsJson)
    .slice(0, MAX_CONVERSATION_CONTEXT_ATTACHMENTS_PER_MESSAGE)
    .map((attachment) => ({
      id: attachment.id,
      name: scrubConversationContextMetadata(attachment.name, "Attachment", 200),
      mimeType: attachment.mimeType,
      size: attachment.size,
    }));
}

const SHORTENED_MIDDLE = "…\n\n[middle of message omitted]\n\n";
const OMITTED_EXCERPT = "[Message excerpt omitted]";
const MAX_EXCERPT_ESCAPED_BYTES = 40 * 1024;

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

function headUtf8(value: string, maximumBytes: number): string {
  const { text, truncated } = truncateUtf8(value, maximumBytes);
  if (!truncated || /^\s/u.test(value.slice(text.length))) return text;
  const wordEnd = text.search(/\s\S*$/u);
  return wordEnd > text.length / 2 ? text.slice(0, wordEnd) : text;
}

function boundExcerptText(head: string, tail: string, maximumBytes: number): string {
  const available = maximumBytes - byteLength(SHORTENED_MIDDLE);
  const keptTail = tail.trim()
    ? neutralizeUntrustedAgentText(tailUtf8(tail, Math.floor(available * 0.4)))
    : "";
  if (!keptTail.trim()) return headUtf8(head, maximumBytes);
  let headBytes = available - byteLength(keptTail);
  while (headBytes > 0) {
    const candidate = neutralizeUntrustedAgentText(
      `${headUtf8(head, headBytes)}${SHORTENED_MIDDLE}${keptTail}`,
    );
    const overflow = byteLength(candidate) - maximumBytes;
    if (overflow <= 0) return candidate;
    headBytes -= overflow;
  }
  return headUtf8(head, maximumBytes);
}

function escapedBytes(value: string): number {
  return byteLength(JSON.stringify(value)) - 2;
}

/**
 * Defense-in-depth only. The user previews the exact bounded copy because any
 * visible chat prose may legitimately contain material no pattern can detect.
 * Media stays in its source chat; only its durable identity travels.
 */
export function scrubAndBoundExcerpt(
  row: ConversationContextSourceRow,
  remainingBytes = MAX_CONVERSATION_CONTEXT_UPDATE_EXCERPT_BYTES,
): ConversationContextExcerpt {
  // Redact, then neutralize instruction-shaped text another model may have
  // written, then bound: neutralizing grows the text, so the cap comes last.
  const head = cleanExcerptText(row.content);
  const tail = row.contentTruncated ? cleanExcerptText(row.tail ?? "") ?? "" : head ?? "";
  const boundTo = (limit: number) => head === null
    ? truncateUtf8(
        row.contentTruncated ? OMITTED_EXCERPT : "[Empty message omitted]",
        limit,
      )
    : !row.contentTruncated && byteLength(head) <= limit
      ? { text: head, truncated: false }
      : { text: boundExcerptText(head, tail, limit), truncated: true };
  let limit = Math.min(MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES, remainingBytes);
  let bounded = boundTo(limit);
  while (limit > 0 && escapedBytes(bounded.text) > MAX_EXCERPT_ESCAPED_BYTES) {
    limit = Math.min(
      limit - 1,
      Math.floor(limit * MAX_EXCERPT_ESCAPED_BYTES / escapedBytes(bounded.text)),
    );
    bounded = boundTo(limit);
  }
  if (!bounded.text) bounded = { text: OMITTED_EXCERPT, truncated: true };
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

export interface CollectedConversationContextExcerpts {
  excerpts: ConversationContextExcerpt[];
  droppedMessageCount: number;
  withheldMessageCount: number;
}

export function collectConversationContextExcerpts(
  database: Database.Database,
  sourceConversationId: string,
  selectedIds: readonly string[] | null,
  excludedMessageId?: string,
  route?: ContinuationRouteFilter,
  finalAnswerBytes = MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES,
): CollectedConversationContextExcerpts | null {
  const countEligible = (routed: ReturnType<typeof continuationRouteSql>) => (database.prepare(`
    SELECT COUNT(*) AS count FROM messages
    WHERE conversation_id = ? AND ${CONVERSATION_CONTEXT_MESSAGE_SQL}
      ${selectedIds ? `AND id IN (${selectedIds.map(() => "?").join(", ")})` : ""}
      ${excludedMessageId ? "AND id <> ?" : ""}
      ${routed.sql}
  `).get(
    sourceConversationId,
    ...(selectedIds ?? []),
    ...(excludedMessageId ? [excludedMessageId] : []),
    ...routed.parameters,
  ) as { count: number }).count;
  const eligibleCount = countEligible(continuationRouteSql(route));
  const withheldMessageCount = route
    ? Math.min(countEligible(continuationRouteSql()) - eligibleCount, 1_000_000)
    : 0;
  if (selectedIds && eligibleCount !== selectedIds.length) {
    throw new Error(
      "Only visible user and assistant messages from the selected source chat can be shared.",
    );
  }
  if (eligibleCount < 1) {
    return withheldMessageCount > 0
      ? { excerpts: [], droppedMessageCount: 0, withheldMessageCount }
      : null;
  }
  const shareBytes = selectedIds
    ? Math.floor(MAX_CONVERSATION_CONTEXT_TOTAL_BYTES / eligibleCount)
    : MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES;
  const excerptBytes = (final: boolean) => Math.min(
    final ? finalAnswerBytes : MAX_CONVERSATION_CONTEXT_UPDATE_EXCERPT_BYTES,
    shareBytes,
  );
  const facts = turnContextFactsReader(database);
  const withAgent = (excerpt: ConversationContextExcerpt): ConversationContextExcerpt => {
    const agent = excerpt.role === "assistant" ? facts(excerpt.sourceTurnId)?.agent : undefined;
    return agent ? { ...excerpt, agent } : excerpt;
  };
  let retainedBytes = 0;
  let retainedJsonBytes = 2;
  const retain = (excerpt: ConversationContextExcerpt): boolean => {
    const bytes = byteLength(excerpt.content);
    const jsonBytes = byteLength(JSON.stringify(excerpt)) + 1
      + (facts(excerpt.sourceTurnId)?.state ? TURN_MARKER_BYTES : 0);
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
    : conversationContextOpeningRow(database, sourceConversationId, excludedMessageId, route);
  let opening = openingRow ? withAgent(scrubAndBoundExcerpt(openingRow, excerptBytes(false))) : null;
  if (opening && !retain(opening)) opening = null;
  const window: ConversationContextExcerpt[] = [];
  for (const row of conversationContextSourceRows(
    database,
    sourceConversationId,
    MAX_CONVERSATION_CONTEXT_MESSAGES,
    selectedIds ?? undefined,
    excludedMessageId,
    route,
    finalAnswerBytes,
  )) {
    if (window.length + (opening ? 1 : 0) >= MAX_CONVERSATION_CONTEXT_MESSAGES) break;
    if (opening && row.id === opening.sourceMessageId) {
      window.push(opening);
      opening = null;
      continue;
    }
    const excerpt = withAgent(scrubAndBoundExcerpt(row, excerptBytes(row.final)));
    if (!retain(excerpt)) break;
    window.push(excerpt);
  }
  const marked = new Set<string>();
  const excerpts = [...(opening ? [opening] : []), ...window.reverse()].reverse().map((excerpt) => {
    const state = facts(excerpt.sourceTurnId)?.state;
    if (!state || marked.has(excerpt.sourceTurnId!)) return excerpt;
    marked.add(excerpt.sourceTurnId!);
    return { ...excerpt, turn: state };
  }).reverse();
  if (excerpts.length < 1) {
    throw new Error("The selected chat context exceeds the shared size limit.");
  }
  return {
    excerpts,
    droppedMessageCount: Math.min(
      Math.max(eligibleCount - excerpts.length, 0),
      1_000_000,
    ),
    withheldMessageCount,
  };
}
