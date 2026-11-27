import type Database from "better-sqlite3";
import {
  CONVERSATION_HISTORY_PAGE_SIZE,
  MAX_CONVERSATION_HISTORY_BYTES,
  type ConversationHistoryCursor,
  type ConversationHistoryRequest,
} from "../../shared/conversation-history";
import { RecordNotFoundError } from "./errors";
import { cachedStatement } from "./statement-cache";

export interface ConversationHistoryScope {
  units: ConversationHistoryCursor[];
  older: ConversationHistoryCursor | null;
  upper: string | null;
}

const HISTORY_UNITS = `
  SELECT id, requested_at AS at, 'turn' AS kind FROM agent_turns WHERE conversation_id = ?
  UNION ALL
  SELECT id, created_at AS at, 'message' AS kind FROM messages
    WHERE conversation_id = ? AND turn_id IS NULL
`;

export function selectConversationHistory(
  database: Database.Database,
  conversationId: string,
  request: ConversationHistoryRequest = {},
  limit = CONVERSATION_HISTORY_PAGE_SIZE,
): ConversationHistoryScope {
  let target: ConversationHistoryCursor | undefined;
  if (request.messageId) {
    const message = cachedStatement(database, `SELECT id, turn_id, created_at FROM messages
      WHERE conversation_id = ? AND id = ?`).get(conversationId, request.messageId) as
      { id: string; turn_id: string | null; created_at: string } | undefined;
    if (!message) throw new RecordNotFoundError("This message is no longer available.");
    if (message.turn_id) {
      target = cachedStatement(database, `SELECT id, requested_at AS at, 'turn' AS kind
        FROM agent_turns WHERE conversation_id = ? AND id = ?`)
        .get(conversationId, message.turn_id) as ConversationHistoryCursor | undefined;
    } else target = { id: message.id, at: message.created_at, kind: "message" };
  } else if (request.turnId) {
    target = cachedStatement(database, `SELECT id, requested_at AS at, 'turn' AS kind
      FROM agent_turns WHERE conversation_id = ? AND id = ?`)
      .get(conversationId, request.turnId) as ConversationHistoryCursor | undefined;
  }
  if ((request.turnId || request.messageId) && !target) {
    throw new RecordNotFoundError("This turn is no longer available.");
  }
  const cursor = request.before ?? target;
  const boundary = cursor ? `WHERE (at, id, kind) ${target ? "<=" : "<"} (?, ?, ?)` : "";
  const units = cachedStatement(database, `SELECT * FROM (${HISTORY_UNITS}) ${boundary}
    ORDER BY at DESC, id DESC, kind DESC LIMIT ?`).all(
    conversationId, conversationId, ...(cursor ? [cursor.at, cursor.id, cursor.kind] : []), limit + 1,
  ) as ConversationHistoryCursor[];
  const hasMore = units.length > limit;
  if (hasMore) units.pop();
  const next = target ? cachedStatement(database, `SELECT MIN(at) AS at FROM (${HISTORY_UNITS}) WHERE at > ?`)
    .get(conversationId, conversationId, target.at) as { at: string | null } : null;
  return { units, older: hasMore ? units.at(-1)! : null, upper: request.before?.at ?? next?.at ?? null };
}

const HISTORY_TABLES = ["agent_turns", "turn_git_artifacts", "messages", "activities",
  "subagent_traces", "agent_reasonings", "agent_plans", "checkpoints", "conversation_context_packets"] as const;
type HistoryTable = typeof HISTORY_TABLES[number];
const CONVERSATION_TABLES = ["thread_usage", "agent_goals", "diff_review_summaries",
  "diff_review_states", "diff_review_notes"] as const;

function historyConversationColumn(table: HistoryTable): string {
  return table === "conversation_context_packets" ? "target_conversation_id" : "conversation_id";
}

export function historyPredicate(
  table: HistoryTable,
  scope: ConversationHistoryScope,
  conversationId: string,
): { sql: string; parameters: string[] } {
  const turns = scope.units.filter(({ kind }) => kind === "turn").map(({ id }) => id);
  const messages = scope.units.filter(({ kind }) => kind === "message").map(({ id }) => id);
  const turnsJson = turns.length ? JSON.stringify(turns) : null;
  const messagesJson = messages.length ? JSON.stringify(messages) : null;
  const inClause = (prefix: string, field: string, json: string | null) =>
    json !== null ? `${prefix}.${field} IN (SELECT value FROM json_each(?))` : "0";
  const turnsParams = turnsJson !== null ? [turnsJson] : [];
  const messagesParams = messagesJson !== null ? [messagesJson] : [];
  const scoped = (sql: string, parameters: string[]) => ({
    sql: `(${table}.${historyConversationColumn(table)} = ? AND ${sql})`,
    parameters: [conversationId, ...parameters],
  });
  if (table === "agent_turns") return scoped(inClause(table, "id", turnsJson), turnsParams);
  if (table === "messages") {
    return scoped(
      `(${inClause(table, "turn_id", turnsJson)} OR ${inClause(table, "id", messagesJson)})`,
      [...turnsParams, ...messagesParams],
    );
  }
  if (table === "conversation_context_packets") {
    return scoped(
      `(consumed_message_id IS NULL OR consumed_message_id IN (SELECT id FROM messages
      WHERE ${inClause("messages", "turn_id", turnsJson)} OR ${inClause("messages", "id", messagesJson)}))`,
      [...turnsParams, ...messagesParams],
    );
  }
  if (table === "turn_git_artifacts" || table === "subagent_traces") {
    return scoped(inClause(table, "turn_id", turnsJson), turnsParams);
  }
  const timestamp = table === "agent_plans" ? "updated_at" : "created_at";
  const lower = scope.older ? scope.units.at(-1)?.at : undefined;
  const legacy = [`${table}.conversation_id = ?`, `${table}.turn_id IS NULL`,
    ...(lower ? [`${table}.${timestamp} >= ?`] : []),
    ...(scope.upper ? [`${table}.${timestamp} <= ?`] : [])];
  return {
    sql: `((${table}.conversation_id = ? AND ${inClause(table, "turn_id", turnsJson)}) OR (${legacy.join(" AND ")}))`,
    parameters: [conversationId, ...turnsParams, conversationId, ...(lower ? [lower] : []), ...(scope.upper ? [scope.upper] : [])],
  };
}

const columns = new WeakMap<Database.Database, Map<string, string[]>>();
const conversationBytesSqlCache = new WeakMap<Database.Database, string>();

function tableColumns(database: Database.Database, table: string): string[] {
  let cache = columns.get(database);
  if (!cache) { cache = new Map(); columns.set(database, cache); }
  let names = cache.get(table);
  if (!names) {
    names = (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
      .map(({ name }) => name);
    cache.set(table, names);
  }
  return names;
}

function columnLengthsSql(
  database: Database.Database,
  table: string,
): string {
  const names = tableColumns(database, table);
  return names.map((name) => `COALESCE(octet_length("${name}"), 0)`).join(" + ");
}

function storedBytes(database: Database.Database, table: string,
  where: { sql: string; parameters: string[] }): number {
  const lengths = columnLengthsSql(database, table);
  return (cachedStatement(database, `SELECT COALESCE(SUM(${lengths}), 0) + COUNT(*) * 256 AS bytes
    FROM ${table} WHERE ${where.sql}`)
    .get(...where.parameters) as { bytes: number }).bytes;
}

export function historyStoredBytes(database: Database.Database, conversationId: string,
  scope: ConversationHistoryScope): number {
  let bytes = 0;
  for (const table of HISTORY_TABLES) {
    const where = historyPredicate(table, scope, conversationId);
    bytes += storedBytes(database, table, where);
    if (table === "messages" || table === "agent_reasonings") {
      const chunkTable = table === "messages" ? "message_content_chunks" : "reasoning_content_chunks";
      const key = table === "messages" ? "message_id" : "reasoning_id";
      bytes += (cachedStatement(database, `SELECT COALESCE(SUM(octet_length(content)), 0) AS bytes
        FROM ${chunkTable} WHERE ${key} IN (SELECT id FROM ${table} WHERE ${where.sql})`)
        .get(...where.parameters) as { bytes: number }).bytes;
    }
    if (bytes > MAX_CONVERSATION_HISTORY_BYTES) return bytes;
  }
  return bytes;
}

export function conversationStoredBytes(database: Database.Database, conversationId: string): number {
  let sql = conversationBytesSqlCache.get(database);
  if (!sql) {
    const parts = CONVERSATION_TABLES.map((table) => {
      const lengths = columnLengthsSql(database, table);
      return `SELECT COALESCE(SUM(${lengths}), 0) + COUNT(*) * 256 AS bytes FROM ${table} WHERE ${table}.conversation_id = @conversationId`;
    });
    sql = `SELECT COALESCE(SUM(bytes), 0) AS bytes FROM (${parts.join(" UNION ALL ")})`;
    conversationBytesSqlCache.set(database, sql);
  }
  return (cachedStatement(database, sql).get({ conversationId }) as { bytes: number }).bytes;
}

function jsonStringUtf8Bytes(value: string): number {
  let bytes = 2;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      if (
        code === 0x22 || code === 0x5c || code === 0x08
        || code === 0x0c || code === 0x0a || code === 0x0d || code === 0x09
      ) {
        bytes += 2;
      } else if (code < 0x20) {
        bytes += 6;
      } else {
        bytes += 1;
      }
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Computes a fast structural UTF-8 JSON byte upper bound without allocating a
 * serialized multi-MB string. Returns a value >= the exact JSON UTF-8 byte
 * length (or `limit + 1` once exceeded).
 */
export function estimateJsonUtf8BytesBound(value: unknown, limit: number): number {
  let total = 0;
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > 32) {
      total = limit + 1;
      return false;
    }
    if (node === null) {
      total += 4;
      return total <= limit;
    }
    const kind = typeof node;
    if (kind === "string") {
      total += jsonStringUtf8Bytes(node as string);
      return total <= limit;
    }
    if (kind === "number") {
      total += 24;
      return total <= limit;
    }
    if (kind === "boolean") {
      total += node ? 4 : 5;
      return total <= limit;
    }
    if (kind !== "object") {
      total += 4;
      return total <= limit;
    }
    if (Array.isArray(node)) {
      total += 2;
      if (total > limit) return false;
      for (let i = 0; i < node.length; i += 1) {
        if (i > 0) total += 1;
        if (!walk(node[i], depth + 1)) return false;
      }
      return total <= limit;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.toJSON === "function") {
      total = limit + 1;
      return false;
    }
    total += 2;
    if (total > limit) return false;
    let first = true;
    for (const key in record) {
      if (!Object.hasOwn(record, key)) continue;
      const entry = record[key];
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") {
        continue;
      }
      if (!first) total += 1;
      first = false;
      total += jsonStringUtf8Bytes(key) + 1;
      if (total > limit) return false;
      if (!walk(entry, depth + 1)) return false;
    }
    return total <= limit;
  };
  walk(value, 0);
  return total;
}

export const HISTORY_TOO_LARGE_MESSAGE =
  "This turn is too large to display. Your history is saved. Open another chat or export your data from Settings.";

export const CONVERSATION_RECORDS_TOO_LARGE_MESSAGE =
  "This chat's review and usage records are too large to display. Your history is saved. Open another chat or export your data from Settings.";
