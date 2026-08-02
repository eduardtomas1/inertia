import type Database from "better-sqlite3";

// Keep chunks below both the released code-point bound and migration 40's
// NUL-safe UTF-8 byte bound. Iterating code points preserves surrogate pairs.
export const STREAM_TEXT_CHUNK_MAX_CHARACTERS = 1_048_576;
export const STREAM_TEXT_CHUNK_MAX_BYTES = 4 * 1_048_576;

/**
 * SQLite stores TEXT as Unicode encoded through UTF-8. JavaScript strings can
 * additionally contain unpaired UTF-16 surrogates, which SQLite replaces on
 * insertion. Normalize that unrepresentable input before both projection and
 * persistence so live, restart, and terminal-compaction views stay identical.
 */
export function normalizeStreamText(value: string): string {
  let normalized = "";
  let copyFrom = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
    } else if (unit < 0xdc00 || unit > 0xdfff) {
      continue;
    }
    normalized += value.slice(copyFrom, index);
    normalized += "\ufffd";
    copyFrom = index + 1;
  }
  return copyFrom === 0 ? value : normalized + value.slice(copyFrom);
}

function assertNormalizedStreamText(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      throw new Error("Stream text must be normalized before durable storage.");
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error("Stream text must be normalized before durable storage.");
    }
  }
}

export function splitStreamTextChunks(value: string): string[] {
  assertNormalizedStreamText(value);
  if (!value) return [];
  const chunks: string[] = [];
  let start = 0;
  let characters = 0;
  let bytes = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)!;
    const width = codePoint > 0xffff ? 2 : 1;
    const characterBytes = codePoint <= 0x7f
      ? 1
      : codePoint <= 0x7ff
        ? 2
        : codePoint <= 0xffff
          ? 3
          : 4;
    if (
      characters > 0
      && (
        characters + 1 > STREAM_TEXT_CHUNK_MAX_CHARACTERS
        || bytes + characterBytes > STREAM_TEXT_CHUNK_MAX_BYTES
      )
    ) {
      chunks.push(value.slice(start, index));
      start = index;
      characters = 0;
      bytes = 0;
    }
    index += width;
    characters += 1;
    bytes += characterBytes;
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
  assertNormalizedStreamText(content);
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
  assertNormalizedStreamText(content);
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
