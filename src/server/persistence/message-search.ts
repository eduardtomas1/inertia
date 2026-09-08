import type Database from "better-sqlite3";
import { MESSAGE_SEARCH_LIMIT, messageSearchExcerpt, messageSearchPattern, type MessageSearchHit, type MessageSearchResult } from "../../shared/message-search";
import { messageSearchQuerySchema } from "../../shared/message-search-schema";

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
  // Yield every raw identity before eligibility filtering so excluded history
  // cannot hide unbounded work inside SQLite before the next deadline check.
  // The covering index supplies chronology without sorting the full table.
  const candidates = database.prepare(`
    SELECT id AS messageId FROM messages INDEXED BY messages_created_id_idx
    ORDER BY created_at DESC, id DESC
  `);
  const eligible = database.prepare(`
    SELECT m.id AS messageId, m.conversation_id AS conversationId,
      c.project_id AS projectId, m.turn_id AS turnId, m.role, m.created_at AS createdAt
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN projects p ON p.id = c.project_id
    LEFT JOIN agent_turns t ON t.id = m.turn_id AND t.conversation_id = c.id
    WHERE m.id = ? AND c.archived_at IS NULL AND (
      m.role = 'user' OR (m.role = 'assistant' AND t.terminal_assistant_message_id = m.id)
    )
  `);
  // Bound each native read: never aggregate an entire chunk history inside
  // SQLite before JavaScript can observe the scan deadline again.
  const base = database.prepare("SELECT substr(CAST(content AS BLOB), 1, ?) AS content FROM messages WHERE id = ?");
  const chunks = database.prepare(`
    SELECT substr(CAST(content AS BLOB), 1, ?) AS content
    FROM message_content_chunks INDEXED BY message_content_chunks_message_sequence_idx
    WHERE message_id = ? ORDER BY sequence ASC
  `);
  let scannedBytes = 0;
  let exhausted = false;
  const expired = (): boolean => {
    if (now() < deadline) return false;
    result.incomplete = true;
    exhausted = true;
    return true;
  };
  const readContent = (messageId: string): string | null => {
    const limit = Math.min(MAX_MESSAGE_BYTES, maximumBytes - scannedBytes);
    let content = Buffer.allocUnsafe(Math.min(65_536, limit));
    let length = 0;
    const append = (bytes: Buffer): boolean => {
      scannedBytes += bytes.length;
      if (length + bytes.length > limit) {
        result.incomplete = true;
        exhausted ||= scannedBytes > maximumBytes;
        return false;
      }
      if (length + bytes.length > content.length) {
        const grown = Buffer.allocUnsafe(Math.min(limit, Math.max(content.length * 2, length + bytes.length)));
        content.copy(grown, 0, 0, length);
        content = grown;
      }
      length += bytes.copy(content, length);
      return true;
    };
    if (expired() || !append((base.get(limit + 1, messageId) as { content: Buffer }).content)) return null;
    const iterator = chunks.iterate(limit + 1, messageId) as IterableIterator<{ content: Buffer }>;
    try {
      while (!expired()) {
        const next = iterator.next();
        if (next.done) return content.subarray(0, length).toString("utf8");
        if (!append(next.value.content)) return null;
      }
      return null;
    } finally { iterator.return?.(); }
  };
  database.transaction(() => {
    for (const { messageId } of candidates.iterate() as Iterable<{ messageId: string }>) {
      if (now() >= deadline || scannedBytes >= maximumBytes) {
        result.incomplete = true;
        break;
      }
      const candidate = eligible.get(messageId) as Omit<MessageSearchHit, "snippet" | "matchStart" | "matchEnd"> | undefined;
      if (!candidate) continue;
      const content = readContent(candidate.messageId);
      if (exhausted) break;
      if (content === null) continue;
      if (expired()) break;
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
