import type Database from "better-sqlite3";

import { forkHistoryPartSchema } from "../../shared/orchestration-forks";
import { boundedSubagentText } from "../provider/subagent-trace";
import { neutralizeUntrustedAgentText } from "../runtime/untrusted-agent-text";
import { MAX_PORTABLE_HISTORY_BUDGET, MAX_PORTABLE_HISTORY_CANDIDATES, type PortableHistoryItem } from "./portable-history";

/** The fork itself authorizes access to its immutable inherited context. */
export function portableForkHistory(database: Database.Database, threadId: string, excluded: readonly string[]) {
  const where = `kind = 'fork-history' AND thread_id = ? AND json_extract(payload_json, '$.part') = 0
    AND json_extract(payload_json, '$.kind') IN ('user-message','assistant-message','command','file','plan','error')
    AND id NOT IN (SELECT value FROM json_each(?))`;
  const args = [threadId, JSON.stringify(excluded)];
  const count = (database.prepare(`SELECT COUNT(*) AS count FROM orchestration_v2_entities WHERE ${where}`)
    .get(...args) as { count: number }).count;
  const select = `SELECT id, payload_json FROM orchestration_v2_entities WHERE ${where}`;
  const rows = database.prepare(`${select} ORDER BY revision DESC LIMIT ?`)
    .all(...args, MAX_PORTABLE_HISTORY_CANDIDATES - 3) as { id: string; payload_json: string }[];
  for (const [kind, direction] of [["user-message", "ASC"], ["user-message", "DESC"], ["assistant-message", "DESC"]] as const) {
    const row = database.prepare(`${select} AND json_extract(payload_json, '$.kind') = ? ORDER BY revision ${direction} LIMIT 1`)
      .get(...args, kind) as typeof rows[number] | undefined;
    if (row && !rows.some(({ id }) => id === row.id)) rows.push(row);
  }
  const candidates = rows.map(({ payload_json }) => forkHistoryPartSchema.parse(JSON.parse(payload_json)))
    .sort((a, b) => a.ordinal - b.ordinal);
  const items: PortableHistoryItem[] = [];
  for (const first of candidates) {
    const size = database.prepare(`SELECT SUM(length(CAST(json_extract(payload_json, '$.text') AS BLOB))) AS bytes,
      COUNT(*) AS parts FROM orchestration_v2_entities WHERE kind = 'fork-history' AND thread_id = ?
      AND json_extract(payload_json, '$.ordinal') = ?`).get(threadId, first.ordinal) as { bytes: number; parts: number };
    if (size.bytes > MAX_PORTABLE_HISTORY_BUDGET || size.parts > 4_096 || size.parts !== first.parts) continue;
    const parts = database.prepare(`SELECT json_extract(payload_json, '$.text') AS text FROM orchestration_v2_entities
      WHERE kind = 'fork-history' AND thread_id = ? AND json_extract(payload_json, '$.ordinal') = ?
      ORDER BY json_extract(payload_json, '$.part')`).all(threadId, first.ordinal) as { text: string }[];
    const original = parts.map(({ text }) => text).join("");
    const text = neutralizeUntrustedAgentText(boundedSubagentText(original, original.length) ?? "");
    if (Buffer.byteLength(text) > MAX_PORTABLE_HISTORY_BUDGET) continue;
    items.push({ id: first.id, threadId, sourceThreadId: first.sourceThreadId,
      runId: first.sourceRunId, turnId: first.sourceTurnId, providerBackingId: null,
      role: first.kind === "user-message" ? "user" : "assistant",
      kind: first.kind === "file" ? "file-change" : first.kind as PortableHistoryItem["kind"],
      status: first.status, text, origin: "Inherited fork history; retrieve full inherited items with inertia_fork_history." });
  }
  return { items, omittedCount: count - items.length };
}

/** Preserve opening/latest intent and bounded recent context across local and inherited history. */
export function boundedHistoryCandidates(items: PortableHistoryItem[]) {
  if (items.length <= MAX_PORTABLE_HISTORY_CANDIDATES) return items;
  const kept = new Set(items.slice(-(MAX_PORTABLE_HISTORY_CANDIDATES - 3)));
  const first = items.find(({ kind }) => kind === "user-message");
  const recent = [...items].reverse();
  const user = recent.find(({ kind }) => kind === "user-message");
  const assistant = recent.find(({ kind }) => kind === "assistant-message");
  for (const item of [first, user, assistant]) if (item) kept.add(item);
  return items.filter((item) => kept.has(item));
}
