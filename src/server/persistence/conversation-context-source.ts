import { StringDecoder } from "node:string_decoder";
import type Database from "better-sqlite3";

import { MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES } from "../../shared/conversation-context";
import type { MessageRow } from "./rows";

// Leave room for redaction before the final excerpt cap, without loading an
// entire message or aggregating its durable streaming chunks inside SQLite.
const MAX_SOURCE_BYTES = 2 * MAX_CONVERSATION_CONTEXT_EXCERPT_BYTES;

export type ConversationContextSourceRow = Pick<
  MessageRow, "id" | "turn_id" | "role" | "created_at" | "attachments_json" | "content"
> & { contentTruncated: boolean };

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
  `).iterate(MAX_SOURCE_BYTES + 1, conversationId, ...(messageIds ?? []), limit) as Iterable<
    Omit<ConversationContextSourceRow, "content" | "contentTruncated"> & { content: Buffer }
  >;
  const chunks = database.prepare(`
    SELECT substr(CAST(content AS BLOB), 1, ?) AS content
    FROM message_content_chunks WHERE message_id = ? ORDER BY sequence LIMIT ?
  `);
  for (const row of rows) {
    const parts = [row.content];
    let bytes = row.content.length;
    if (bytes <= MAX_SOURCE_BYTES) {
      // Each released stream chunk contains at least one byte. This row cap
      // also bounds traversal of a message streamed one byte at a time.
      for (const chunk of chunks.iterate(
        MAX_SOURCE_BYTES + 1, row.id, MAX_SOURCE_BYTES + 1,
      ) as Iterable<{ content: Buffer }>) {
        parts.push(chunk.content);
        bytes += chunk.content.length;
        if (bytes > MAX_SOURCE_BYTES) break;
      }
    }
    const contentTruncated = bytes > MAX_SOURCE_BYTES;
    // BLOB substr is NUL-safe. StringDecoder omits an unfinished UTF-8 code
    // point at the byte boundary instead of inventing a replacement character.
    let content = new StringDecoder("utf8").write(Buffer.concat(
      parts, Math.min(bytes, MAX_SOURCE_BYTES),
    ));
    if (contentTruncated) {
      // Never retain the beginning of a credential cut short by the read cap.
      // Redaction still runs on the complete retained tokens before sharing.
      content = content.replace(/\S+$/u, "");
    }
    yield { ...row, content, contentTruncated };
  }
}
