import type Database from "better-sqlite3";

import { FORK_HISTORY_PART_CHARACTERS, forkHistoryPartSchema, type ForkHistoryPart } from "../../shared/orchestration-forks";
import { commandFingerprint } from "./json";

type SourceItem = Omit<ForkHistoryPart, "id" | "threadId" | "ordinal" | "part" | "parts" | "text">;
interface TurnBoundary { id: string; conversationId: string; completedAt: string | null }

/** Immutable visible history; no credential, live tool, private reasoning or attachment payloads. */
export function captureForkHistory(database: Database.Database, targetThreadId: string, boundary: TurnBoundary,
  write: (part: ForkHistoryPart) => void): { items: number; parts: number } {
  let ordinal = 0;
  let count = 0;
  const append = (part: Omit<ForkHistoryPart, "id" | "threadId">) => {
    write({ ...part, threadId: targetThreadId,
      id: commandFingerprint({ targetThreadId, ordinal: part.ordinal, part: part.part }) });
    count += 1;
  };
  // Read pages before writing: a SQLite iterator must never remain open across a write.
  let afterRevision = 0;
  let priorOrdinal = -1;
  while (true) {
    const page = database.prepare(`SELECT revision, payload_json FROM orchestration_v2_entities
      WHERE kind = 'fork-history' AND thread_id = ? AND revision > ? ORDER BY revision LIMIT 100`)
      .all(boundary.conversationId, afterRevision) as { revision: number; payload_json: string }[];
    if (!page.length) break;
    for (const row of page) {
      const part = forkHistoryPartSchema.parse(JSON.parse(row.payload_json));
      if (part.ordinal !== priorOrdinal) { if (priorOrdinal !== -1) ordinal += 1; priorOrdinal = part.ordinal; }
      append({ ...part, ordinal });
    }
    afterRevision = page.at(-1)!.revision;
  }
  if (priorOrdinal !== -1) ordinal += 1;
  const boundaryRow = database.prepare("SELECT requested_at, rowid AS position FROM agent_turns WHERE id = ? AND conversation_id = ?")
    .get(boundary.id, boundary.conversationId) as { requested_at: string; position: number } | undefined;
  if (!boundaryRow) throw new Error("The fork source turn is unavailable.");
  const eligible = `SELECT id FROM agent_turns WHERE conversation_id = @thread
    AND (requested_at, rowid) <= (@requested, @position)
    AND id NOT IN (SELECT id FROM orchestration_v2_entities WHERE kind = 'rolled-back-turn' AND thread_id = @thread)`;
  const parameters = { thread: boundary.conversationId, requested: boundaryRow.requested_at,
    position: boundaryRow.position, completed: boundary.completedAt ?? boundaryRow.requested_at };
  const index = `SELECT 'message' AS source, messages.id, messages.created_at AS at, messages.rowid AS position
      FROM messages WHERE conversation_id = @thread AND (turn_id IN (${eligible}) OR (turn_id IS NULL AND created_at <= @completed))
    UNION ALL SELECT 'activity', activities.id, activities.created_at, activities.rowid FROM activities
      WHERE conversation_id = @thread AND kind <> 'reasoning' AND turn_id IN (${eligible})
    UNION ALL SELECT 'plan', agent_plans.run_id, agent_plans.updated_at, agent_plans.rowid FROM agent_plans
      WHERE conversation_id = @thread AND turn_id IN (${eligible})`;
  let cursor: { at: string; source: string; position: number } | null = null;
  while (true) {
    const page = database.prepare(`SELECT * FROM (${index})
      ${cursor ? "WHERE (at, source, position) > (@afterAt, @afterSource, @afterPosition)" : ""}
      ORDER BY at, source, position LIMIT 100`).all({ ...parameters,
        ...(cursor ? { afterAt: cursor.at, afterSource: cursor.source, afterPosition: cursor.position } : {}) }) as
      { source: "message" | "activity" | "plan"; id: string; at: string; position: number }[];
    if (!page.length) break;
    for (const entry of page) {
      const item = sourceItem(database, boundary.conversationId, entry.source, entry.id);
      if (!item) continue;
      let part = 0;
      for (const text of item.read()) {
        append({ ...item.source, ordinal, part: part++, parts: item.parts, text });
      }
      ordinal += 1;
    }
    cursor = page.at(-1)!;
  }
  return { items: ordinal, parts: count };
}

function sourceItem(database: Database.Database, threadId: string, kind: "message" | "activity" | "plan", id: string):
  { source: SourceItem; parts: number; read(): Generator<string> } | null {
  const table = kind === "message" ? "messages" : kind === "activity" ? "activities" : "agent_plans";
  const key = kind === "plan" ? "run_id" : "id";
  const content = kind === "message" ? "content" : kind === "activity"
    ? "title || CASE WHEN detail IS NULL THEN '' ELSE char(10) || detail END"
    : "COALESCE(explanation, '') || char(10) || steps_json";
  const row = database.prepare(`SELECT turn_id,
    (SELECT run_id FROM agent_turns WHERE id = ${table}.turn_id) AS run_id,
    (SELECT status FROM agent_turns WHERE id = ${table}.turn_id) AS turn_status,
    ${kind === "message" ? "role" : kind === "activity" ? "kind" : "'plan'"} AS kind,
    ${kind === "plan" ? "updated_at" : "created_at"} AS created_at, length(${content}) AS length
    FROM ${table} WHERE ${key} = ? AND conversation_id = ?`).get(id, threadId) as
    { turn_id: string | null; run_id: string | null; turn_status: string | null; kind: string; created_at: string; length: number } | undefined;
  if (!row) return null;
  const source: SourceItem = { sourceThreadId: threadId, sourceItemId: `${kind}:${id}`,
    sourceRunId: row.run_id, sourceTurnId: row.turn_id,
    kind: (kind === "message" ? `${row.kind}-message` : row.kind) as SourceItem["kind"],
    status: row.turn_status === "failed" || row.turn_status === "interrupted" || row.turn_status === "cancelled"
      ? row.turn_status : row.turn_status === "completed" || row.turn_status === null ? "completed" : "partial",
    createdAt: row.created_at };
  // SQLite substr counts code points and cannot split a surrogate pair. Every
  // individual read/event is bounded even when the complete message is large.
  const chunks = kind === "message" ? (database.prepare(`SELECT COALESCE(SUM(
    (length(content) + ? - 1) / ?), 0) AS parts FROM message_content_chunks WHERE message_id = ?`)
    .get(FORK_HISTORY_PART_CHARACTERS, FORK_HISTORY_PART_CHARACTERS, id) as { parts: number }).parts : 0;
  const totalParts = Math.ceil(row.length / FORK_HISTORY_PART_CHARACTERS) + chunks;
  return { source, parts: Math.max(1, totalParts), read: function* () {
    if (totalParts === 0) { yield ""; return; }
    const read = database.prepare(`SELECT substr(${content}, ?, ?) AS text FROM ${table} WHERE ${key} = ? AND conversation_id = ?`);
    for (let start = 1; start <= row.length; start += FORK_HISTORY_PART_CHARACTERS) {
      yield (read.get(start, FORK_HISTORY_PART_CHARACTERS, id, threadId) as { text: string }).text;
    }
    if (kind !== "message") return;
    let after = 0;
    while (true) {
      const chunk = database.prepare(`SELECT sequence, length(content) AS length FROM message_content_chunks
        WHERE message_id = ? AND sequence > ? ORDER BY sequence LIMIT 1`).get(id, after) as
        { sequence: number; length: number } | undefined;
      if (!chunk) break;
      for (let start = 1; start <= chunk.length; start += FORK_HISTORY_PART_CHARACTERS) {
        yield (database.prepare("SELECT substr(content, ?, ?) AS text FROM message_content_chunks WHERE message_id = ? AND sequence = ?")
          .get(start, FORK_HISTORY_PART_CHARACTERS, id, chunk.sequence) as { text: string }).text;
      }
      after = chunk.sequence;
    }
  } };
}
