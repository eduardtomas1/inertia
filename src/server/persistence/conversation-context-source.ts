import type Database from "better-sqlite3";

import type { ProviderId } from "../../shared/contracts";
import { MAX_CONVERSATION_CONTEXT_UPDATE_EXCERPT_BYTES } from "../../shared/conversation-context";
import { htmlRenderProviderNote, isHtmlRenderTitle } from "../../shared/html-render-reference";
import type { MessageRow } from "./rows";
import { readBoundedMessageTail, readBoundedMessageText } from "./bounded-message-text";

// Leave room for redaction before the final excerpt cap, without loading an
// entire message or aggregating its durable streaming chunks inside SQLite.
const SOURCE_PREFIX_BYTES = 2 * MAX_CONVERSATION_CONTEXT_UPDATE_EXCERPT_BYTES;

export type ConversationContextSourceRow = Pick<
  MessageRow, "id" | "turn_id" | "role" | "created_at" | "attachments_json" | "content"
> & { contentTruncated: boolean; tail: string | null; final: boolean };

export const CONVERSATION_CONTEXT_MESSAGE_SQL = `(messages.role IN ('user', 'assistant')
  OR (messages.role = 'system' AND messages.html_render_json IS NOT NULL AND messages.turn_id IS NOT NULL))`;

export interface ContinuationRouteFilter {
  backendProfileId: string;
  endpointIdentity: string | null;
  includeUnattributed: boolean;
  /**
   * A provider handoff to this route carried the chat's earlier messages
   * across. Messages other providers produced up to that handoff's request
   * time stay eligible; the target provider's own messages from other
   * endpoints and later messages from other routes remain withheld.
   */
  handoff?: { before: string; providerId: ProviderId };
}

export function continuationRouteTurnSql(
  turn: string,
  route: ContinuationRouteFilter,
): { sql: string; parameters: Array<string | null> } {
  const handoff = route.handoff === undefined
    ? ""
    : ` OR (${turn}.requested_at <= ? AND ${turn}.provider_id <> ?)`;
  return {
    sql: `((${turn}.backend_profile_id = ?
      AND (CASE WHEN json_valid(${turn}.continuation_identity_json)
        THEN json_extract(${turn}.continuation_identity_json, '$.endpointIdentity')
      END) IS ?)${handoff})`,
    parameters: [
      route.backendProfileId,
      route.endpointIdentity,
      ...(route.handoff === undefined ? [] : [route.handoff.before, route.handoff.providerId]),
    ],
  };
}

export function continuationRouteSql(route?: ContinuationRouteFilter): {
  sql: string;
  parameters: Array<string | null>;
} {
  if (!route) return { sql: "", parameters: [] };
  const turn = continuationRouteTurnSql("route_turn", route);
  const unattributed = route.includeUnattributed ? "messages.turn_id IS NULL OR " : "";
  const handoff = route.handoff === undefined
    ? ""
    : "(messages.turn_id IS NULL AND messages.created_at <= ?) OR ";
  return {
    sql: `AND (${unattributed}${handoff}EXISTS (
      SELECT 1 FROM agent_turns AS route_turn
      WHERE route_turn.id = messages.turn_id AND ${turn.sql}
    ))`,
    parameters: [
      ...(route.handoff === undefined ? [] : [route.handoff.before]),
      ...turn.parameters,
    ],
  };
}

type StoredSourceRow = Omit<ConversationContextSourceRow, "content" | "contentTruncated" | "tail"> & {
  content: Buffer;
  page_title?: unknown;
};

function pageRow({ page_title: title, ...row }: StoredSourceRow): ConversationContextSourceRow {
  return {
    ...row,
    role: "assistant",
    content: isHtmlRenderTitle(title) ? htmlRenderProviderNote(title) : "[page]",
    contentTruncated: false,
    tail: null,
    final: false,
  };
}

function sourceRowReader(
  database: Database.Database,
): (row: StoredSourceRow, excerptBytes: number, final: boolean) => ConversationContextSourceRow {
  const longerPrefix = database.prepare(`
    SELECT COALESCE(substr(CAST(content AS BLOB), 1, ?), X'') AS content
    FROM messages WHERE id = ?
  `);
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
  return (row, excerptBytes, final) => {
    const sourceBytes = 2 * excerptBytes;
    const prefix = sourceBytes > SOURCE_PREFIX_BYTES && row.content.length > SOURCE_PREFIX_BYTES
      ? (longerPrefix.get(sourceBytes + 1, row.id) as { content: Buffer }).content
      : row.content;
    const text = readBoundedMessageText(prefix, () => chunks.iterate(
      // Released chunks contain at least one byte, bounding row traversal too.
      sourceBytes + 1, row.id, sourceBytes + 1,
    ) as Iterable<{ content: Buffer }>, sourceBytes);
    const tail = text.truncated
      ? readBoundedMessageTail(
          () => (contentTail.get(excerptBytes, row.id) as { content: Buffer }).content,
          () => tailChunks.iterate(
            excerptBytes, row.id, excerptBytes,
          ) as Iterable<{ content: Buffer }>,
          excerptBytes,
        )
      : null;
    return { ...row, content: text.content, contentTruncated: text.truncated, tail, final };
  };
}

/** Newest first, so callers can stop reading as soon as their packet is full. */
export function* conversationContextSourceRows(
  database: Database.Database,
  conversationId: string,
  limit: number,
  messageIds?: readonly string[],
  excludedMessageId?: string,
  route?: ContinuationRouteFilter,
  finalAnswerBytes = MAX_CONVERSATION_CONTEXT_UPDATE_EXCERPT_BYTES,
): Generator<ConversationContextSourceRow> {
  const routed = continuationRouteSql(route);
  const rows = database.prepare(`
    SELECT id, turn_id, role, created_at, attachments_json,
      COALESCE(substr(CAST(content AS BLOB), 1, ?), X'') AS content,
      CASE WHEN role = 'system' THEN json_extract(html_render_json, '$.title') END AS page_title
    FROM messages
    WHERE conversation_id = ? AND ${CONVERSATION_CONTEXT_MESSAGE_SQL}
      ${messageIds ? `AND id IN (${messageIds.map(() => "?").join(", ")})` : ""}
      ${excludedMessageId ? "AND id <> ?" : ""}
      ${routed.sql}
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `).iterate(
    SOURCE_PREFIX_BYTES + 1,
    conversationId,
    ...(messageIds ?? []),
    ...(excludedMessageId ? [excludedMessageId] : []),
    ...routed.parameters,
    limit,
  ) as Iterable<StoredSourceRow>;
  const read = sourceRowReader(database);
  let awaitingAnswer = true;
  for (const row of rows) {
    if (row.role === "system") {
      yield pageRow(row);
      continue;
    }
    const final = row.role === "assistant" && awaitingAnswer;
    awaitingAnswer = row.role === "user";
    yield read(row, final ? finalAnswerBytes : MAX_CONVERSATION_CONTEXT_UPDATE_EXCERPT_BYTES, final);
  }
}

export function conversationContextOpeningRow(
  database: Database.Database,
  conversationId: string,
  excludedMessageId?: string,
  route?: ContinuationRouteFilter,
): ConversationContextSourceRow | null {
  const routed = continuationRouteSql(route);
  const row = database.prepare(`
    SELECT id, turn_id, role, created_at, attachments_json,
      COALESCE(substr(CAST(content AS BLOB), 1, ?), X'') AS content
    FROM messages
    WHERE conversation_id = ? AND role = 'user'
      ${excludedMessageId ? "AND id <> ?" : ""}
      ${routed.sql}
    ORDER BY created_at ASC, rowid ASC
    LIMIT 1
  `).get(
    SOURCE_PREFIX_BYTES + 1,
    conversationId,
    ...(excludedMessageId ? [excludedMessageId] : []),
    ...routed.parameters,
  ) as StoredSourceRow | undefined;
  return row
    ? sourceRowReader(database)(row, MAX_CONVERSATION_CONTEXT_UPDATE_EXCERPT_BYTES, false)
    : null;
}
