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
): Generator<ConversationContextSourceRow> {
  const rows = database.prepare(`
    SELECT id, turn_id, role, created_at, attachments_json,
      COALESCE(substr(CAST(content AS BLOB), 1, ?), X'') AS content
    FROM messages
    WHERE conversation_id = ? AND role IN ('user', 'assistant')
      ${messageIds ? `AND id IN (${messageIds.map(() => "?").join(", ")})` : ""}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).iterate(MAX_SOURCE_BYTES + 1, conversationId, ...(messageIds ?? []), limit) as Iterable<StoredSourceRow>;
  const read = sourceRowReader(database);
  for (const row of rows) yield read(row);
}

export function conversationContextOpeningRow(
  database: Database.Database,
  conversationId: string,
): ConversationContextSourceRow | null {
  const row = database.prepare(`
    SELECT id, turn_id, role, created_at, attachments_json,
      COALESCE(substr(CAST(content AS BLOB), 1, ?), X'') AS content
    FROM messages
    WHERE conversation_id = ? AND role = 'user'
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `).get(MAX_SOURCE_BYTES + 1, conversationId) as StoredSourceRow | undefined;
  return row ? sourceRowReader(database)(row) : null;
}
