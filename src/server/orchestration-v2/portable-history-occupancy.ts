import type Database from "better-sqlite3";

const IMAGE_ALLOWANCE = 8_192;
const ATTACHMENT_ALLOWANCE = 4_096;

/** Bytes of covered transcript and inherited items, one byte per token, plus attachment allowances for user messages. */
export function coveredHistoryOccupancy(
  database: Database.Database,
  threadId: string,
  coveredItemIds: readonly string[],
): number {
  if (coveredItemIds.length === 0) return 0;
  const covered = JSON.stringify(coveredItemIds);
  const messages = database.prepare(`SELECT COALESCE(SUM(length(CAST(messages.content AS BLOB))
      + COALESCE((SELECT SUM(length(CAST(chunks.content AS BLOB))) FROM message_content_chunks chunks
        WHERE chunks.message_id = messages.id), 0)
      + CASE WHEN messages.role = 'user' THEN COALESCE((SELECT SUM(CASE
          WHEN json_extract(attachment.value, '$.mimeType') LIKE 'image/%' THEN ${IMAGE_ALLOWANCE}
          ELSE ${ATTACHMENT_ALLOWANCE} END)
        FROM json_each(CASE WHEN json_valid(messages.attachments_json) THEN messages.attachments_json ELSE '[]' END) attachment), 0)
      ELSE 0 END), 0) AS bytes
    FROM messages WHERE messages.conversation_id = ? AND messages.id IN (SELECT value FROM json_each(?))`)
    .get(threadId, covered) as { bytes: number };
  const inherited = database.prepare(`SELECT COALESCE(SUM(length(CAST(json_extract(part.payload_json, '$.text') AS BLOB))), 0) AS bytes
    FROM orchestration_v2_entities part
    WHERE part.kind = 'fork-history' AND part.thread_id = ?
      AND json_extract(part.payload_json, '$.ordinal') IN (
        SELECT json_extract(first.payload_json, '$.ordinal') FROM orchestration_v2_entities first
        WHERE first.kind = 'fork-history' AND first.thread_id = ? AND first.id IN (SELECT value FROM json_each(?)))`)
    .get(threadId, threadId, covered) as { bytes: number };
  return messages.bytes + inherited.bytes;
}
