import type Database from "better-sqlite3";
import { MESSAGE_SEARCH_LIMIT, messageSearchExcerpt, messageSearchPattern, type MessageSearchHit, type MessageSearchResult } from "../../shared/message-search";
import { messageSearchQuerySchema } from "../../shared/message-search-schema";
import { MESSAGE_PROJECTION_COLUMNS } from "./stream-text-storage";

const MAX_MESSAGE_BYTES = 16 * 1_048_576;
const MAX_SCAN_BYTES = 256 * 1_048_576;
const MAX_SCAN_MS = 2_000;

/** Runs only on a dedicated read connection in the search worker. */
export function searchMessages(
  database: Database.Database,
  queryInput: string,
  options: { now?: () => number; maxScanMs?: number; maxScanBytes?: number } = {},
): MessageSearchResult {
  const query = messageSearchQuerySchema.parse(queryInput);
  const pattern = messageSearchPattern(query);
  const now = options.now ?? performance.now.bind(performance);
  const deadline = now() + (options.maxScanMs ?? MAX_SCAN_MS);
  const maximumBytes = options.maxScanBytes ?? MAX_SCAN_BYTES;
  const result: MessageSearchResult = {
    kind: "conversation.messages.search", query, hits: [], hasMore: false, incomplete: false,
  };
  // Sort identities only: do not materialize every transcript before LIMIT.
  // The read transaction keeps eligibility and chunk reconstruction coherent.
  const candidates = database.prepare(`
    SELECT m.id AS messageId, m.conversation_id AS conversationId,
      c.project_id AS projectId, m.turn_id AS turnId, m.role, m.created_at AS createdAt
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN projects p ON p.id = c.project_id
    LEFT JOIN agent_turns t ON t.id = m.turn_id AND t.conversation_id = c.id
    WHERE c.archived_at IS NULL AND (
      m.role = 'user' OR (m.role = 'assistant' AND t.terminal_assistant_message_id = m.id)
    )
    ORDER BY m.created_at DESC, m.id DESC
  `);
  const size = database.prepare(`
    SELECT length(CAST(content AS BLOB)) + COALESCE((
      SELECT sum(length(CAST(content AS BLOB))) FROM message_content_chunks WHERE message_id = messages.id
    ), 0) AS bytes FROM messages WHERE id = ?
  `);
  const text = database.prepare(`SELECT content FROM (
    SELECT ${MESSAGE_PROJECTION_COLUMNS} FROM messages WHERE messages.id = ?
  )`);
  let scannedBytes = 0;
  database.transaction(() => {
    for (const candidate of candidates.iterate() as Iterable<Omit<MessageSearchHit, "snippet" | "matchStart" | "matchEnd">>) {
      if (now() >= deadline || scannedBytes >= maximumBytes) {
        result.incomplete = true;
        break;
      }
      const bytes = (size.get(candidate.messageId) as { bytes: number }).bytes;
      if (bytes > MAX_MESSAGE_BYTES) {
        result.incomplete = true;
        continue;
      }
      if (scannedBytes + bytes > maximumBytes) {
        result.incomplete = true;
        break;
      }
      scannedBytes += bytes;
      const content = (text.get(candidate.messageId) as { content: string }).content;
      const excerpt = messageSearchExcerpt(content, pattern);
      if (!excerpt) continue;
      if (result.hits.length === MESSAGE_SEARCH_LIMIT) {
        result.hasMore = true;
        break;
      }
      result.hits.push({ ...candidate, ...excerpt });
    }
  })();
  return result;
}
