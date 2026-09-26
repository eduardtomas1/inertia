import type Database from "better-sqlite3";
import {
  CONVERSATION_HISTORY_PAGE_SIZE,
  MAX_CONVERSATION_HISTORY_BYTES,
  type ConversationHistoryCursor,
  type ConversationHistoryRequest,
} from "../../shared/conversation-history";

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
    const message = database.prepare(`SELECT id, turn_id, created_at FROM messages
      WHERE conversation_id = ? AND id = ?`).get(conversationId, request.messageId) as
      { id: string; turn_id: string | null; created_at: string } | undefined;
    if (!message) throw new Error("This message is no longer available.");
    if (message.turn_id) {
      target = database.prepare(`SELECT id, requested_at AS at, 'turn' AS kind
        FROM agent_turns WHERE conversation_id = ? AND id = ?`)
        .get(conversationId, message.turn_id) as ConversationHistoryCursor | undefined;
    } else target = { id: message.id, at: message.created_at, kind: "message" };
  } else if (request.turnId) {
    target = database.prepare(`SELECT id, requested_at AS at, 'turn' AS kind
      FROM agent_turns WHERE conversation_id = ? AND id = ?`)
      .get(conversationId, request.turnId) as ConversationHistoryCursor | undefined;
  }
  if ((request.turnId || request.messageId) && !target) {
    throw new Error("This turn is no longer available.");
  }
  const cursor = request.before ?? target;
  const boundary = cursor ? `WHERE (at, id, kind) ${target ? "<=" : "<"} (?, ?, ?)` : "";
  const units = database.prepare(`SELECT * FROM (${HISTORY_UNITS}) ${boundary}
    ORDER BY at DESC, id DESC, kind DESC LIMIT ?`).all(
    conversationId, conversationId, ...(cursor ? [cursor.at, cursor.id, cursor.kind] : []), limit + 1,
  ) as ConversationHistoryCursor[];
  const hasMore = units.length > limit;
  if (hasMore) units.pop();
  const next = target ? database.prepare(`SELECT MIN(at) AS at FROM (${HISTORY_UNITS}) WHERE at > ?`)
    .get(conversationId, conversationId, target.at) as { at: string | null } : null;
  return { units, older: hasMore ? units.at(-1)! : null, upper: request.before?.at ?? next?.at ?? null };
}

/** Fixed table names only; identities always travel as bound SQL parameters. */
export function historyPredicate(
  table: string,
  scope: ConversationHistoryScope,
): { sql: string; parameters: string[] } {
  const turns = scope.units.filter(({ kind }) => kind === "turn").map(({ id }) => id);
  const messages = scope.units.filter(({ kind }) => kind === "message").map(({ id }) => id);
  const inValues = (field: string, values: string[]) => values.length
    ? `${table}.${field} IN (${values.map(() => "?").join(",")})` : "0";
  if (table === "agent_turns") return { sql: inValues("id", turns), parameters: turns };
  if (table === "messages") return {
    sql: `(${inValues("turn_id", turns)} OR ${inValues("id", messages)})`,
    parameters: [...turns, ...messages],
  };
  if (table === "conversation_context_packets") return {
    sql: `(consumed_message_id IS NULL OR consumed_message_id IN (SELECT id FROM messages
      WHERE ${inValues("turn_id", turns).replaceAll(`${table}.`, "messages.")} OR ${inValues("id", messages).replaceAll(`${table}.`, "messages.")}))`,
    parameters: [...turns, ...messages],
  };
  if (["turn_git_artifacts", "subagent_traces"].includes(table)) {
    return { sql: inValues("turn_id", turns), parameters: turns };
  }
  if (["activities", "agent_reasonings", "agent_plans", "checkpoints"].includes(table)) {
    const timestamp = table === "agent_plans" ? "updated_at" : "created_at";
    const lower = scope.older ? scope.units.at(-1)?.at : undefined;
    const legacy = [`${table}.turn_id IS NULL`,
      ...(lower ? [`${table}.${timestamp} >= ?`] : []),
      ...(scope.upper ? [`${table}.${timestamp} <= ?`] : [])];
    return { sql: `(${inValues("turn_id", turns)} OR (${legacy.join(" AND ")}))`,
      parameters: [...turns, ...(lower ? [lower] : []), ...(scope.upper ? [scope.upper] : [])] };
  }
  return { sql: "1", parameters: [] };
}

const HISTORY_TABLES = ["agent_turns", "turn_git_artifacts", "messages", "activities",
  "subagent_traces", "agent_reasonings", "agent_plans", "checkpoints",
  "thread_usage", "agent_goals", "diff_review_summaries", "diff_review_states", "diff_review_notes", "conversation_context_packets"];
const columns = new WeakMap<Database.Database, Map<string, string[]>>();

/** Measure in SQLite before materializing large text or thousands of records. */
export function historyStoredBytes(database: Database.Database, conversationId: string,
  scope: ConversationHistoryScope): number {
  let cache = columns.get(database);
  if (!cache) { cache = new Map(); columns.set(database, cache); }
  let bytes = 0;
  for (const table of HISTORY_TABLES) {
    let names = cache.get(table);
    if (!names) {
      names = (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
        .map(({ name }) => name);
      cache.set(table, names);
    }
    const where = historyPredicate(table, scope);
    const lengths = names.map((name) => `COALESCE(length(CAST("${name}" AS BLOB)), 0)`).join(" + ");
    const conversationColumn = table === "conversation_context_packets" ? "target_conversation_id" : "conversation_id";
    const row = database.prepare(`SELECT COALESCE(SUM(${lengths}), 0) + COUNT(*) * 256 AS bytes
      FROM ${table} WHERE ${conversationColumn} = ? AND (${where.sql})`)
      .get(conversationId, ...where.parameters) as { bytes: number };
    bytes += row.bytes;
    if (table === "messages" || table === "agent_reasonings") {
      const chunkTable = table === "messages" ? "message_content_chunks" : "reasoning_content_chunks";
      const key = table === "messages" ? "message_id" : "reasoning_id";
      bytes += (database.prepare(`SELECT COALESCE(SUM(length(CAST(content AS BLOB))), 0) AS bytes
        FROM ${chunkTable} WHERE ${key} IN (SELECT id FROM ${table}
          WHERE conversation_id = ? AND (${where.sql}))`)
        .get(conversationId, ...where.parameters) as { bytes: number }).bytes;
    }
    if (bytes > MAX_CONVERSATION_HISTORY_BYTES) return bytes;
  }
  return bytes;
}

export const HISTORY_TOO_LARGE_MESSAGE =
  "This turn is too large to display. Your history is saved. Open another chat or export your data from Settings.";
