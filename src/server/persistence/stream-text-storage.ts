import type Database from "better-sqlite3";

// SQLite length(TEXT) counts Unicode code points. Keep the storage invariant
// in the same unit so astral characters are never split between rows and every
// inserted chunk satisfies migration 38's CHECK exactly.
export const STREAM_TEXT_CHUNK_MAX_CHARACTERS = 1_048_576;

export function splitStreamTextChunks(value: string): string[] {
  if (!value) return [];
  const chunks: string[] = [];
  let start = 0;
  let characters = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)!;
    const width = codePoint > 0xffff ? 2 : 1;
    index += width;
    characters += 1;
    if (characters === STREAM_TEXT_CHUNK_MAX_CHARACTERS) {
      chunks.push(value.slice(start, index));
      start = index;
      characters = 0;
    }
  }
  if (start < value.length) chunks.push(value.slice(start));
  return chunks;
}

export function appendMessageContentChunks(
  database: Database.Database,
  messageId: string,
  delta: string,
): boolean {
  if (!delta) return true;
  return database.transaction(() => {
    if (!database.prepare("SELECT 1 FROM messages WHERE id = ?").get(messageId)) {
      return false;
    }
    const insert = database.prepare(
      "INSERT INTO message_content_chunks (message_id, content) VALUES (?, ?)",
    );
    for (const chunk of splitStreamTextChunks(delta)) {
      insert.run(messageId, chunk);
    }
    return true;
  })();
}

export function appendReasoningContentChunks(
  database: Database.Database,
  reasoningId: string,
  delta: string,
): boolean {
  if (!delta) return true;
  return database.transaction(() => {
    if (!database.prepare(
      "SELECT 1 FROM agent_reasonings WHERE id = ?",
    ).get(reasoningId)) return false;
    const insert = database.prepare(
      "INSERT INTO reasoning_content_chunks (reasoning_id, content) VALUES (?, ?)",
    );
    for (const chunk of splitStreamTextChunks(delta)) {
      insert.run(reasoningId, chunk);
    }
    return true;
  })();
}

export const MESSAGE_PROJECTION_COLUMNS = `
  messages.id,
  messages.conversation_id,
  messages.turn_id,
  messages.role,
  messages.content || COALESCE((
    SELECT group_concat(ordered_chunks.content, '')
    FROM (
      SELECT content
      FROM message_content_chunks
      WHERE message_id = messages.id
      ORDER BY sequence ASC
    ) AS ordered_chunks
  ), '') AS content,
  messages.attachments_json,
  messages.created_at
`;

export const REASONING_PROJECTION_COLUMNS = `
  agent_reasonings.id,
  agent_reasonings.conversation_id,
  agent_reasonings.run_id,
  agent_reasonings.turn_id,
  agent_reasonings.content || COALESCE((
    SELECT group_concat(ordered_chunks.content, '')
    FROM (
      SELECT content
      FROM reasoning_content_chunks
      WHERE reasoning_id = agent_reasonings.id
      ORDER BY sequence ASC
    ) AS ordered_chunks
  ), '') AS content,
  agent_reasonings.status,
  agent_reasonings.created_at
`;

export function replaceMessageContent(
  database: Database.Database,
  messageId: string,
  content: string,
): number {
  return database.transaction(() => {
    const result = database.prepare(
      "UPDATE messages SET content = ? WHERE id = ?",
    ).run(content, messageId);
    if (result.changes === 1) {
      database.prepare(
        "DELETE FROM message_content_chunks WHERE message_id = ?",
      ).run(messageId);
    }
    return result.changes;
  })();
}

export function compactMessageContentForTurn(
  database: Database.Database,
  turnId: string,
): void {
  database.prepare(`
    UPDATE messages
    SET content = content || COALESCE((
      SELECT group_concat(ordered_chunks.content, '')
      FROM (
        SELECT content
        FROM message_content_chunks
        WHERE message_id = messages.id
        ORDER BY sequence ASC
      ) AS ordered_chunks
    ), '')
    WHERE turn_id = ?
      AND EXISTS (
        SELECT 1
        FROM message_content_chunks
        WHERE message_id = messages.id
      )
  `).run(turnId);
  database.prepare(`
    DELETE FROM message_content_chunks
    WHERE message_id IN (
      SELECT id FROM messages WHERE turn_id = ?
    )
  `).run(turnId);
}

export function replaceReasoningContent(
  database: Database.Database,
  reasoningId: string,
  content: string,
  status: string,
): number {
  return database.transaction(() => {
    const result = database.prepare(
      "UPDATE agent_reasonings SET content = ?, status = ? WHERE id = ?",
    ).run(content, status, reasoningId);
    if (result.changes === 1) {
      database.prepare(
        "DELETE FROM reasoning_content_chunks WHERE reasoning_id = ?",
      ).run(reasoningId);
    }
    return result.changes;
  })();
}

export function compactReasoningContentForTurn(
  database: Database.Database,
  turnId: string,
): void {
  database.prepare(`
    UPDATE agent_reasonings
    SET content = content || COALESCE((
      SELECT group_concat(ordered_chunks.content, '')
      FROM (
        SELECT content
        FROM reasoning_content_chunks
        WHERE reasoning_id = agent_reasonings.id
        ORDER BY sequence ASC
      ) AS ordered_chunks
    ), '')
    WHERE turn_id = ?
      AND EXISTS (
        SELECT 1
        FROM reasoning_content_chunks
        WHERE reasoning_id = agent_reasonings.id
      )
  `).run(turnId);
  database.prepare(`
    DELETE FROM reasoning_content_chunks
    WHERE reasoning_id IN (
      SELECT id FROM agent_reasonings WHERE turn_id = ?
    )
  `).run(turnId);
}
