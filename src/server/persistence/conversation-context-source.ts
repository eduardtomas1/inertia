import type Database from "better-sqlite3";

import { MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES } from "../../shared/conversation-context";
import type { MessageRow } from "./rows";
import { readBoundedMessageTail, readBoundedMessageText } from "./bounded-message-text";

// Leave room for redaction before the final excerpt cap, without loading an
// entire message or aggregating its durable streaming chunks inside SQLite.
const MAX_SOURCE_BYTES = 2 * MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES;
const MAX_SOURCE_TAIL_BYTES = MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES;

export type ConversationContextSourceRow = Pick<
  MessageRow, "id" | "turn_id" | "role" | "created_at" | "attachments_json" | "content"
> & { contentTruncated: boolean; tail: string | null };

export interface ContinuationRouteFilter {
  backendProfileId: string;
  endpointIdentity: string | null;
  includeUnattributed: boolean;
  /**
   * A provider handoff to this route carried the chat's earlier messages
   * across. Messages up to that handoff's request time stay eligible; later
   * messages from other routes remain withheld.
   */
  handoffBefore?: string;
}

export function continuationRouteSql(route?: ContinuationRouteFilter): {
  sql: string;
  parameters: Array<string | null>;
} {
  if (!route) return { sql: "", parameters: [] };
  const handoff = route.handoffBefore === undefined
    ? ""
    : `
      OR (messages.turn_id IS NULL AND messages.created_at <= ?)
      OR EXISTS (
        SELECT 1 FROM agent_turns AS handoff_turn
        WHERE handoff_turn.id = messages.turn_id
          AND handoff_turn.requested_at <= ?
      )`;
  return {
    sql: `AND (${route.includeUnattributed ? "messages.turn_id IS NULL OR " : ""}EXISTS (
      SELECT 1 FROM agent_turns AS route_turn
      WHERE route_turn.id = messages.turn_id
        AND route_turn.backend_profile_id = ?
        AND (CASE WHEN json_valid(route_turn.continuation_identity_json)
          THEN json_extract(route_turn.continuation_identity_json, '$.endpointIdentity')
        END) IS ?
    )${handoff})`,
    parameters: [
      route.backendProfileId,
      route.endpointIdentity,
      ...(route.handoffBefore === undefined ? [] : [route.handoffBefore, route.handoffBefore]),
    ],
  };
}

type StoredSourceRow = Omit<ConversationContextSourceRow, "content" | "contentTruncated" | "tail"> & {
  content: Buffer;
};

function sourceRowReader(database: Database.Database): (row: StoredSourceRow) => ConversationContextSourceRow {
  const chunks = database.prepare(`
    SELECT substr(CAST(content AS BLOB), 1, ?) AS content
    FROM message_content_chunks WHERE message_id = ? ORDER BY sequence LIMIT ?
  `);
  const tailChunks = database.prepare(`
    SELECT substr(CAST(content AS BLOB), -?) AS content
    FROM message_content_chunks WHERE message_id = ? ORDER BY sequence DESC LIMIT ?
  `);
  const contentTail = database.prepare(`
    SELECT COALESCE(substr(CAST(content AS BLOB), -?), X'') AS content
    FROM messages WHERE id = ?
  `);
  return (row) => {
    const text = readBoundedMessageText(row.content, () => chunks.iterate(
      // Released chunks contain at least one byte, bounding row traversal too.
      MAX_SOURCE_BYTES + 1, row.id, MAX_SOURCE_BYTES + 1,
    ) as Iterable<{ content: Buffer }>, MAX_SOURCE_BYTES);
    const tail = text.truncated
      ? readBoundedMessageTail(
          () => (contentTail.get(MAX_SOURCE_TAIL_BYTES, row.id) as { content: Buffer }).content,
          () => tailChunks.iterate(
            MAX_SOURCE_TAIL_BYTES, row.id, MAX_SOURCE_TAIL_BYTES,
          ) as Iterable<{ content: Buffer }>,
          MAX_SOURCE_TAIL_BYTES,
        )
      : null;
    return { ...row, content: text.content, contentTruncated: text.truncated, tail };
  };
}

/** Newest first, so callers can stop reading as soon as their packet is full. */
export function* conversationContextSourceRows(
  database: Database.Database,
  conversationId: string,
  limit: number,
  messageIds?: readonly string[],
  excludedMessageId?: string,
  route?: ContinuationRouteFilter,
): Generator<ConversationContextSourceRow> {
  const routed = continuationRouteSql(route);
  const rows = database.prepare(`
    SELECT id, turn_id, role, created_at, attachments_json,
      COALESCE(substr(CAST(content AS BLOB), 1, ?), X'') AS content
    FROM messages
    WHERE conversation_id = ? AND role IN ('user', 'assistant')
      ${messageIds ? `AND id IN (${messageIds.map(() => "?").join(", ")})` : ""}
      ${excludedMessageId ? "AND id <> ?" : ""}
      ${routed.sql}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).iterate(
    MAX_SOURCE_BYTES + 1,
    conversationId,
    ...(messageIds ?? []),
    ...(excludedMessageId ? [excludedMessageId] : []),
    ...routed.parameters,
    limit,
  ) as Iterable<StoredSourceRow>;
  const read = sourceRowReader(database);
  for (const row of rows) yield read(row);
}

export function conversationContextOpeningRow(
  database: Database.Database,
  conversationId: string,
  excludedMessageId?: string,
  route?: ContinuationRouteFilter,
): ConversationContextSourceRow | null {
  const routed = continuationRouteSql(route);
  const row = database.prepare(`
    SELECT id, turn_id, role, created_at, attachments_json,
      COALESCE(substr(CAST(content AS BLOB), 1, ?), X'') AS content
    FROM messages
    WHERE conversation_id = ? AND role = 'user'
      ${excludedMessageId ? "AND id <> ?" : ""}
      ${routed.sql}
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `).get(
    MAX_SOURCE_BYTES + 1,
    conversationId,
    ...(excludedMessageId ? [excludedMessageId] : []),
    ...routed.parameters,
  ) as StoredSourceRow | undefined;
  return row ? sourceRowReader(database)(row) : null;
}
