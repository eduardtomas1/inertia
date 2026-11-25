import type Database from "better-sqlite3";
import { cachedStatement } from "./statement-cache";

export const MESSAGE_SEARCH_INDEXED_MESSAGE_MAX_BYTES = 256 * 1_024;
const BATCH_ROWS = 64;
const MERGE_PAGES = 32;

const MESSAGE_BYTES_SQL = `
  SELECT length(CAST(content AS BLOB)) + COALESCE((
    SELECT sum(length(CAST(content AS BLOB))) FROM message_content_chunks
    WHERE message_id = messages.id
  ), 0)
  FROM messages WHERE id = ?
`;
const INDEX_MESSAGE_SQL = `
  INSERT INTO message_search_index (rowid, content)
  SELECT ?, m.content || COALESCE((
    SELECT group_concat(ordered_chunks.content, '') FROM (
      SELECT content FROM message_content_chunks WHERE message_id = m.id ORDER BY sequence ASC
    ) AS ordered_chunks
  ), '')
  FROM messages m WHERE m.id = ?
`;

export interface MessageSearchIndexProgress {
  remaining: boolean;
  backfillComplete: boolean;
}

export function indexMessageSearchBatch(
  database: Database.Database,
  options: { budgetMs: number; now?: () => number },
): MessageSearchIndexProgress {
  const now = options.now ?? performance.now.bind(performance);
  return indexMessageSearchDocuments(database, now, now() + options.budgetMs);
}

export function mergeMessageSearchIndex(
  database: Database.Database,
  options: { budgetMs: number; now?: () => number },
): boolean {
  const now = options.now ?? performance.now.bind(performance);
  const deadline = now() + options.budgetMs;
  return database.transaction((): boolean => {
    const changes = cachedStatement(database, "SELECT total_changes()").pluck();
    let merging = false;
    do {
      const before = changes.get() as number;
      database.exec(`INSERT INTO message_search_index (message_search_index, rank) VALUES ('merge', ${MERGE_PAGES})`);
      merging = (changes.get() as number) - before >= 2;
    } while (merging && now() < deadline);
    return merging;
  }).immediate();
}

function indexMessageSearchDocuments(
  database: Database.Database,
  now: () => number,
  deadline: number,
): MessageSearchIndexProgress {
  return database.transaction((): MessageSearchIndexProgress => {
    const bytes = cachedStatement(database, MESSAGE_BYTES_SQL).pluck();
    const index = cachedStatement(database, INDEX_MESSAGE_SQL);
    const indexable = (messageId: string): boolean =>
      (bytes.get(messageId) as number | null ?? 0) <= MESSAGE_SEARCH_INDEXED_MESSAGE_MAX_BYTES;
    let worked = false;
    const spent = (): boolean => worked && now() >= deadline;

    const stale = cachedStatement(database, `
      SELECT d.document_id AS documentId, d.message_id AS messageId
      FROM message_search_documents d INDEXED BY message_search_documents_unindexed_idx
      WHERE d.state <> 1 AND d.state = 0
        AND NOT EXISTS (SELECT 1 FROM message_content_chunks WHERE message_id = d.message_id)
      LIMIT ?
    `).all(BATCH_ROWS) as Array<{ documentId: number; messageId: string }>;
    const settle = cachedStatement(database, "UPDATE message_search_documents SET state = ? WHERE document_id = ?");
    let staleRemaining = stale.length === BATCH_ROWS;
    for (const document of stale) {
      if (spent()) { staleRemaining = true; break; }
      worked = true;
      if (indexable(document.messageId)) {
        index.run(document.documentId, document.messageId);
        settle.run(1, document.documentId);
      } else {
        settle.run(2, document.documentId);
      }
    }

    const backfilled = backfillBatch(database, spent, () => { worked = true; }, indexable, index);
    return { remaining: staleRemaining || backfilled.remaining, backfillComplete: backfilled.complete };
  }).immediate();
}

function backfillBatch(
  database: Database.Database,
  spent: () => boolean,
  work: () => void,
  indexable: (messageId: string) => boolean,
  index: Database.Statement,
): { remaining: boolean; complete: boolean } {
  const backfill = cachedStatement(database, `
    SELECT complete, before_created_at AS createdAt, before_message_id AS messageId
    FROM message_search_backfill WHERE singleton = 1
  `).get() as { complete: number; createdAt: string | null; messageId: string | null } | undefined;
  if (!backfill || backfill.complete === 1) return { remaining: false, complete: true };
  if (spent()) return { remaining: true, complete: false };
  const resumed = backfill.createdAt !== null && backfill.messageId !== null;
  const rows = cachedStatement(database, `
    SELECT m.id AS messageId, m.created_at AS createdAt, d.document_id AS documentId
    FROM messages m INDEXED BY messages_created_id_idx
    LEFT JOIN message_search_documents d ON d.message_id = m.id
    WHERE ${resumed ? "(m.created_at, m.id) < (?, ?)" : "1"}
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
  `).all(...(resumed ? [backfill.createdAt, backfill.messageId] : []), BATCH_ROWS) as Array<{
    messageId: string; createdAt: string; documentId: number | null;
  }>;
  const document = cachedStatement(database, "INSERT INTO message_search_documents (message_id, state) VALUES (?, ?)");
  const advance = cachedStatement(database, `
    UPDATE message_search_backfill SET before_created_at = ?, before_message_id = ? WHERE singleton = 1
  `);
  let visited = 0;
  for (const row of rows) {
    if (spent()) break;
    if (row.documentId === null) {
      work();
      if (indexable(row.messageId)) {
        index.run(document.run(row.messageId, 1).lastInsertRowid, row.messageId);
      } else {
        document.run(row.messageId, 2);
      }
    }
    advance.run(row.createdAt, row.messageId);
    visited += 1;
  }
  const finished = visited === rows.length && rows.length < BATCH_ROWS;
  if (finished) {
    cachedStatement(database, `
      UPDATE message_search_backfill
      SET complete = 1, before_created_at = NULL, before_message_id = NULL WHERE singleton = 1
    `).run();
  }
  return { remaining: !finished, complete: finished };
}
