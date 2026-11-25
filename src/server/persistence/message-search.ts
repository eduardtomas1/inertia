import type Database from "better-sqlite3";
import {
  MESSAGE_SEARCH_LIMIT, messageSearchExcerpt, messageSearchPattern,
  type MessageSearchContinuation, type MessageSearchHit, type MessageSearchResult,
} from "../../shared/message-search";
import { messageSearchContinuationSchema, messageSearchQuerySchema } from "../../shared/message-search-schema";
import { messageSearchIndexQuery } from "./message-search-terms";

const MAX_MESSAGE_BYTES = 16 * 1_048_576;
const MAX_SCAN_BYTES = 256 * 1_048_576;
const MAX_SCAN_MS = 2_000;
export const MESSAGE_SEARCH_SORTED_CANDIDATE_LIMIT = 20_000;

type Position = MessageSearchContinuation;
type Bound = { position: Position; inclusive: boolean } | null;
type OrderedRow = Position & { documentId: number | null; state: number | null };
type Candidate = Position & { verify: boolean };

interface CandidateStream {
  head: Candidate | null;
  advance(): void;
  close(): void;
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function comparePositions(left: Position, right: Position): number {
  return compareText(left.createdAt, right.createdAt) || compareText(left.messageId, right.messageId);
}

function tighter(left: Bound, right: Bound): Bound {
  if (!left) return right;
  if (!right) return left;
  const order = comparePositions(left.position, right.position);
  if (order !== 0) return order < 0 ? left : right;
  return left.inclusive ? right : left;
}

function boundSql(bound: Bound): string {
  return bound ? `(m.created_at, m.id) ${bound.inclusive ? "<=" : "<"} (?, ?)` : "1";
}

function boundParameters(bound: Bound): string[] {
  return bound ? [bound.position.createdAt, bound.position.messageId] : [];
}

function candidateStream<T>(rows: IterableIterator<T>, map: (row: T) => Candidate): CandidateStream {
  const stream: CandidateStream = {
    head: null,
    advance() {
      const next = rows.next();
      stream.head = next.done ? null : map(next.value);
    },
    close() { rows.return?.(); },
  };
  stream.advance();
  return stream;
}

function sortedMembership(database: Database.Database, expression: string, expired: () => boolean): Float64Array | null {
  let members = new Float64Array(4_096);
  let length = 0;
  let checked = 0;
  const rows = database.prepare(`
    SELECT rowid FROM message_search_index WHERE message_search_index MATCH ? ORDER BY rowid
  `).pluck().iterate(expression) as IterableIterator<number>;
  try {
    for (const rowid of rows) {
      if (++checked % 4_096 === 0 && expired()) return null;
      if (length === members.length) {
        const grown = new Float64Array(members.length * 2);
        grown.set(members);
        members = grown;
      }
      members[length++] = rowid;
    }
  } finally { rows.return?.(); }
  return members.subarray(0, length);
}

function contains(members: Float64Array, value: number): boolean {
  let low = 0;
  let high = members.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const current = members[middle]!;
    if (current === value) return true;
    if (current < value) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

/** Runs only on a dedicated read connection in the search worker. */
export function searchMessages(
  database: Database.Database,
  queryInput: string,
  options: {
    now?: () => number; maxScanMs?: number; maxScanBytes?: number;
    continuation?: MessageSearchContinuation | null; sortedCandidateLimit?: number;
  } = {},
): MessageSearchResult {
  const query = messageSearchQuerySchema.parse(queryInput);
  const continuation = options.continuation ? messageSearchContinuationSchema.parse(options.continuation) : null;
  const pattern = messageSearchPattern(query);
  const now = options.now ?? performance.now.bind(performance);
  const startedAt = now();
  const maxScanMs = options.maxScanMs ?? MAX_SCAN_MS;
  const deadline = startedAt + maxScanMs;
  const membershipDeadline = startedAt + Math.max(1, Math.floor(maxScanMs / 2));
  const maximumBytes = options.maxScanBytes ?? MAX_SCAN_BYTES;
  const sortedCandidateLimit = options.sortedCandidateLimit ?? MESSAGE_SEARCH_SORTED_CANDIDATE_LIMIT;
  const result: MessageSearchResult = {
    kind: "conversation.messages.search", query, hits: [], hasMore: false, incomplete: false,
    continuation: null, indexing: false,
  };
  const eligible = database.prepare(`
    SELECT m.id AS messageId, m.conversation_id AS conversationId,
      c.project_id AS projectId, m.turn_id AS turnId,
      CASE WHEN m.role = 'system' THEN 'assistant' ELSE m.role END AS role, m.created_at AS createdAt
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN projects p ON p.id = c.project_id
    LEFT JOIN agent_turns t ON t.id = m.turn_id AND t.conversation_id = c.id
    WHERE m.id = ? AND c.archived_at IS NULL AND (
      m.role = 'user' OR (m.role = 'assistant' AND t.terminal_assistant_message_id = m.id)
      OR (m.role = 'system' AND t.id IS NOT NULL AND m.sent_to_user = 1)
    )
  `);
  // Bound each native read: never aggregate an entire chunk history inside
  // SQLite before JavaScript can observe the scan deadline again.
  // substr() over an empty blob yields NULL, not an empty blob. An eligible
  // empty message (recovery imports allow one) must read as empty content.
  const base = database.prepare("SELECT COALESCE(substr(CAST(content AS BLOB), 1, ?), x'') AS content FROM messages WHERE id = ?");
  const chunks = database.prepare(`
    SELECT substr(CAST(content AS BLOB), 1, ?) AS content
    FROM message_content_chunks INDEXED BY message_content_chunks_message_sequence_idx
    WHERE message_id = ? ORDER BY sequence ASC
  `);
  let scannedBytes = 0;
  let exhausted = false;
  const expired = (): boolean => {
    if (now() < deadline) return false;
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
  const ordered = (bound: Bound, documents: boolean): IterableIterator<OrderedRow> => database.prepare(`
    SELECT m.id AS messageId, m.created_at AS createdAt,
      ${documents ? "d.document_id" : "NULL"} AS documentId, ${documents ? "d.state" : "NULL"} AS state
    FROM messages m INDEXED BY messages_created_id_idx
    ${documents ? "LEFT JOIN message_search_documents d ON d.message_id = m.id" : ""}
    WHERE ${boundSql(bound)}
    ORDER BY m.created_at DESC, m.id DESC
  `).iterate(...boundParameters(bound)) as IterableIterator<OrderedRow>;
  const position = ({ createdAt, messageId }: Position): Position => ({ createdAt, messageId });
  const cursor: Bound = continuation ? { position: continuation, inclusive: true } : null;

  database.transaction(() => {
    const backfill = database.prepare(`
      SELECT complete, before_created_at AS createdAt, before_message_id AS messageId
      FROM message_search_backfill WHERE singleton = 1
    `).get() as { complete: number; createdAt: string | null; messageId: string | null } | undefined;
    const complete = backfill?.complete === 1;
    result.indexing = !complete;
    const expression = messageSearchIndexQuery(query);
    const streams: CandidateStream[] = [];
    try {
      if (!expression) {
        streams.push(candidateStream(ordered(cursor, false), (row) => ({ ...position(row), verify: true })));
      } else {
        const candidates = database.prepare(`
          SELECT count(*) FROM (
            SELECT rowid FROM message_search_index WHERE message_search_index MATCH ? LIMIT ?
          )
        `).pluck().get(expression, sortedCandidateLimit + 1) as number;
        if (candidates > sortedCandidateLimit) {
          const members = maxScanMs <= 0
            ? null
            : sortedMembership(database, expression, () => now() >= membershipDeadline);
          if (!members) {
            streams.push(candidateStream(ordered(cursor, false), (row) => ({ ...position(row), verify: true })));
          } else {
            streams.push(candidateStream(ordered(cursor, true), (row) => ({
              ...position(row),
              verify: row.documentId === null || row.state !== 1 || contains(members, row.documentId),
            })));
          }
        } else {
          streams.push(candidateStream(database.prepare(`
            SELECT m.id AS messageId, m.created_at AS createdAt
            FROM message_search_index
            JOIN message_search_documents d ON d.document_id = message_search_index.rowid
            JOIN messages m ON m.id = d.message_id
            WHERE message_search_index MATCH ? AND d.state = 1 AND ${boundSql(cursor)}
            ORDER BY m.created_at DESC, m.id DESC
          `).iterate(expression, ...boundParameters(cursor)) as IterableIterator<Position>, (row) => ({ ...position(row), verify: true })));
          streams.push(candidateStream(database.prepare(`
            SELECT m.id AS messageId, m.created_at AS createdAt
            FROM message_search_documents d INDEXED BY message_search_documents_unindexed_idx
            JOIN messages m ON m.id = d.message_id
            WHERE d.state <> 1 AND ${boundSql(cursor)}
            ORDER BY m.created_at DESC, m.id DESC
          `).iterate(...boundParameters(cursor)) as IterableIterator<Position>, (row) => ({ ...position(row), verify: true })));
          if (!complete) {
            const unvisited: Bound = backfill?.createdAt && backfill.messageId
              ? { position: { createdAt: backfill.createdAt, messageId: backfill.messageId }, inclusive: false }
              : null;
            streams.push(candidateStream(ordered(tighter(cursor, unvisited), true), (row) => ({
              ...position(row), verify: row.documentId === null,
            })));
          }
        }
      }
      for (;;) {
        let candidate: Candidate | null = null;
        for (const { head } of streams) {
          if (head && (!candidate || comparePositions(head, candidate) > 0)) candidate = head;
        }
        if (!candidate) break;
        if (now() >= deadline || scannedBytes >= maximumBytes) {
          result.incomplete = true;
          result.continuation = position(candidate);
          break;
        }
        let verify = false;
        for (const stream of streams) {
          if (!stream.head || comparePositions(stream.head, candidate) !== 0) continue;
          verify ||= stream.head.verify;
          stream.advance();
        }
        if (!verify) continue;
        const hit = eligible.get(candidate.messageId) as Omit<MessageSearchHit, "snippet" | "matchStart" | "matchEnd"> | undefined;
        if (!hit) continue;
        const content = readContent(hit.messageId);
        if (exhausted) {
          result.incomplete = true;
          result.continuation = position(candidate);
          break;
        }
        if (content === null) continue;
        const excerpt = messageSearchExcerpt(content, pattern);
        if (!excerpt) continue;
        if (result.hits.length === MESSAGE_SEARCH_LIMIT) {
          result.hasMore = true;
          result.continuation = position(candidate);
          break;
        }
        result.hits.push({ ...hit, ...excerpt });
      }
    } finally {
      for (const stream of streams) stream.close();
    }
  })();
  return result;
}
