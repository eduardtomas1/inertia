import type Database from "better-sqlite3";

import { MAX_PORTABLE_COMMAND_INPUT_BYTES, MAX_PORTABLE_COMMAND_OUTPUT_BYTES } from "../persistence/turn-context-facts";

const IMAGE_ALLOWANCE = 8_192;
const ATTACHMENT_ALLOWANCE = 4_096;
const ACTIVITY_ITEM_BYTES = MAX_PORTABLE_COMMAND_INPUT_BYTES + MAX_PORTABLE_COMMAND_OUTPUT_BYTES + 256;

/** Stored history is mostly prose and tool output, about four UTF-8 bytes per token (T3 `estimateTextTokens`). */
const tokens = (bytes: string) => `((${bytes}) + 3) / 4`;

/**
 * Estimated tokens of covered transcript, activity and inherited items: each
 * item's UTF-8 bytes / 4, rounded up per item, plus whole attachment
 * allowances for user messages. The new prompt and restored history are
 * still budgeted at one byte per token.
 */
export function coveredHistoryOccupancy(
  database: Database.Database,
  threadId: string,
  coveredItemIds: readonly string[],
): number {
  if (coveredItemIds.length === 0) return 0;
  const covered = JSON.stringify(coveredItemIds);
  const messages = database.prepare(`SELECT COALESCE(SUM(${tokens(`length(CAST(messages.content AS BLOB))
      + COALESCE((SELECT SUM(length(CAST(chunks.content AS BLOB))) FROM message_content_chunks chunks
        WHERE chunks.message_id = messages.id), 0)`)}
      + CASE WHEN messages.role = 'user' THEN COALESCE((SELECT SUM(CASE
          WHEN json_extract(attachment.value, '$.mimeType') LIKE 'image/%' THEN ${IMAGE_ALLOWANCE}
          ELSE ${ATTACHMENT_ALLOWANCE} END)
        FROM json_each(CASE WHEN json_valid(messages.attachments_json) THEN messages.attachments_json ELSE '[]' END) attachment), 0)
      ELSE 0 END), 0) AS tokens
    FROM messages WHERE messages.conversation_id = ? AND messages.id IN (SELECT value FROM json_each(?))`)
    .get(threadId, covered) as { tokens: number };
  const inherited = database.prepare(`SELECT COALESCE(SUM(${tokens("bytes")}), 0) AS tokens FROM (
      SELECT SUM(length(CAST(json_extract(part.payload_json, '$.text') AS BLOB))) AS bytes
      FROM orchestration_v2_entities part
      WHERE part.kind = 'fork-history' AND part.thread_id = ?
        AND json_extract(part.payload_json, '$.ordinal') IN (
          SELECT json_extract(first.payload_json, '$.ordinal') FROM orchestration_v2_entities first
          WHERE first.kind = 'fork-history' AND first.thread_id = ? AND first.id IN (SELECT value FROM json_each(?)))
      GROUP BY json_extract(part.payload_json, '$.ordinal'))`)
    .get(threadId, threadId, covered) as { tokens: number };
  const activity = database.prepare(`SELECT COALESCE(SUM(${tokens(`min(length(CAST(title AS BLOB))
      + COALESCE(length(CAST(detail AS BLOB)), 0), ${ACTIVITY_ITEM_BYTES})`)}), 0) AS tokens
    FROM activities WHERE conversation_id = ? AND ('activity:' || id) IN (SELECT value FROM json_each(?))`)
    .get(threadId, covered) as { tokens: number };
  const plans = database.prepare(`SELECT COALESCE(SUM(${tokens(`length(CAST(COALESCE(explanation, '') AS BLOB))
      + length(CAST(steps_json AS BLOB))`)}), 0) AS tokens
    FROM agent_plans WHERE conversation_id = ? AND ('plan:' || run_id) IN (SELECT value FROM json_each(?))`)
    .get(threadId, covered) as { tokens: number };
  const files = database.prepare(`SELECT COALESCE(SUM(${tokens("length(CAST(files_json AS BLOB))")}), 0) AS tokens
    FROM turn_git_artifacts WHERE conversation_id = ? AND ('files:' || id) IN (SELECT value FROM json_each(?))`)
    .get(threadId, covered) as { tokens: number };
  return messages.tokens + inherited.tokens + activity.tokens + plans.tokens + files.tokens;
}
