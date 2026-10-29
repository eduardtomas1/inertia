import type Database from "better-sqlite3";

import { readBoundedMessageText } from "../persistence/bounded-message-text";
import { continuationRouteSql, type ContinuationRouteFilter } from "../persistence/conversation-context-source";
import { boundedSubagentText } from "../provider/subagent-trace";
import { neutralizeUntrustedAgentText } from "../runtime/untrusted-agent-text";
import { WATCHER_NOTE_HISTORY_LABELS } from "../../shared/watcher";
import { sentConversationContextReferences } from "../persistence/conversation-context-packet-repository";
import { sentReferenceBlocks, type ContinuationHistoryBlock } from "../persistence/continuation-history";
import { RESTORED_CHAT_HISTORY_LABEL } from "../persistence/conversation-context-transport";
import { providerHandoffBlockBytes, providerHandoffFilesBlock } from "../persistence/provider-handoff-files";
import { lastTurnCommands, providerHandoffReason } from "../persistence/turn-context-facts";
import {
  MAX_PORTABLE_HISTORY_BUDGET, MAX_PORTABLE_HISTORY_CANDIDATES,
  portableHistoryBudget, selectPortableHistory, type PortableHistoryItem,
} from "./portable-history";

interface SourceRow {
  id: string;
  turn_id: string | null;
  run_id: string | null;
  role: "user" | "assistant";
  status: string | null;
  created_at: string;
  position: number;
}

/** Read bounded candidates without SQL string aggregation or clipping individual messages. */
export function portableHistorySource(database: Database.Database, input: {
  threadId: string;
  excludedMessageId?: string;
  excludedItemIds?: readonly string[];
  route?: ContinuationRouteFilter;
}) {
  const route = continuationRouteSql(input.route);
  const eligibleWhere = `messages.conversation_id = ? AND messages.role IN ('user','assistant')
    AND messages.id <> ? ${route.sql}`;
  if ((input.excludedItemIds?.length ?? 0) > 2_048) throw new Error("Too many covered history items.");
  const eligibleParameters = [input.threadId, input.excludedMessageId ?? "", ...route.parameters];
  const where = `${eligibleWhere} AND messages.id NOT IN (SELECT value FROM json_each(?))`;
  const parameters = [...eligibleParameters, JSON.stringify(input.excludedItemIds ?? [])];
  const count = (clause: string, values: Array<string | null>) =>
    (database.prepare(`SELECT count(*) AS count FROM messages WHERE ${clause}`).get(...values) as { count: number }).count;
  const eligible = count(where, parameters);
  const routedCount = count(eligibleWhere, eligibleParameters);
  const total = count("conversation_id = ? AND role IN ('user','assistant') AND id <> ?", parameters.slice(0, 2));
  const select = `SELECT messages.id, messages.turn_id, messages.role, messages.created_at,
    messages.rowid AS position, turns.status, turns.run_id
    FROM messages LEFT JOIN agent_turns turns ON turns.id = messages.turn_id
    WHERE ${where}`;
  // Reserve places for opening/latest user and latest assistant even in a long stream of updates.
  const rows = database.prepare(`${select} ORDER BY messages.created_at DESC, messages.rowid DESC LIMIT ?`)
    .all(...parameters, MAX_PORTABLE_HISTORY_CANDIDATES - 3) as SourceRow[];
  for (const [role, direction] of [["user", "ASC"], ["user", "DESC"], ["assistant", "DESC"]] as const) {
    const row = database.prepare(`${select} AND messages.role = ?
      ORDER BY messages.created_at ${direction}, messages.rowid ${direction} LIMIT 1`)
      .get(...parameters, role) as SourceRow | undefined;
    if (row && !rows.some(({ id }) => id === row.id)) rows.push(row);
  }
  rows.sort((left, right) => left.created_at.localeCompare(right.created_at) || left.position - right.position);
  const prefix = database.prepare("SELECT substr(CAST(content AS BLOB), 1, ?) AS content FROM messages WHERE id = ?");
  const chunks = database.prepare(`SELECT substr(CAST(content AS BLOB), 1, ?) AS content
    FROM message_content_chunks WHERE message_id = ? ORDER BY sequence LIMIT ?`);
  const items: PortableHistoryItem[] = [];
  for (const row of rows) {
    const value = prefix.get(MAX_PORTABLE_HISTORY_BUDGET + 1, row.id) as { content: Buffer | null };
    const text = readBoundedMessageText(value.content ?? Buffer.alloc(0), () => chunks.iterate(
      MAX_PORTABLE_HISTORY_BUDGET + 1, row.id, MAX_PORTABLE_HISTORY_BUDGET + 1,
    ) as Iterable<{ content: Buffer }>, MAX_PORTABLE_HISTORY_BUDGET);
    if (text.truncated) continue;
    // Preserve complete content except mandatory secret redaction and instruction delimiters.
    const cleaned = neutralizeUntrustedAgentText(boundedSubagentText(text.content, text.content.length) ?? "");
    if (Buffer.byteLength(cleaned) > MAX_PORTABLE_HISTORY_BUDGET) continue;
    const status = row.status === "failed" || row.status === "cancelled" || row.status === "interrupted"
      ? row.status : row.status === null || row.status === "completed" ? "completed" : "partial";
    items.push({ id: row.id, threadId: input.threadId, turnId: row.turn_id, runId: row.run_id,
      providerBackingId: null, role: row.role, kind: row.role === "user" ? "user-message" : "assistant-message",
      status, text: cleaned });
  }
  return { items, omittedCount: eligible - items.length, withheldCount: total - routedCount };
}

export function readPortableContinuationHistory(database: Database.Database, input:
  Parameters<typeof portableHistorySource>[1] & {
    capacityBytes: number;
    currentPromptBytes: number;
    imageCount: number;
    modelWindow?: number;
    configuredCap?: number;
    nativeUsedTokens?: number;
    reportedWindow?: number;
  }) {
  const source = portableHistorySource(database, input);
  if (source.items.length === 0 && source.omittedCount === 0 && source.withheldCount === 0) return null;
  const budget = Math.min(Math.max(0, input.capacityBytes), portableHistoryBudget(input));
  const references = sentConversationContextReferences(database, input.threadId,
    source.items.filter(({ role }) => role === "user").map(({ id }) => id));
  const notes = database.prepare("SELECT id, json_extract(watcher_note_json, '$.automatic') AS automatic FROM messages WHERE id IN (SELECT value FROM json_each(?)) AND watcher_note_json IS NOT NULL")
    .all(JSON.stringify(source.items.map(({ id }) => id))) as { id: string; automatic: number | null }[];
  const items = source.items.map((item) => {
    const attached = references.filter(({ messageId }) => messageId === item.id).slice(0, 16);
    const note = notes.find(({ id }) => id === item.id);
    return { ...item, ...(attached.length ? { references: attached.map(({ title }) => `[referenced chat: ${title}]`) } : {}),
      ...(note ? { origin: WATCHER_NOTE_HISTORY_LABELS[note.automatic === 1 ? "automatic" : "forwarded"] } : {}) };
  });
  const selected = selectPortableHistory({ threadId: input.threadId, items,
    previouslyOmitted: source.omittedCount, budget });
  const label = input.excludedItemIds?.length ? "Context added since this session last ran" : RESTORED_CHAT_HISTORY_LABEL;
  const blocks: ContinuationHistoryBlock[] = [{ label: `${label} · ${selected.items.length} messages`, content: selected.rendered }];
  let remaining = budget - selected.cost;
  const append = (block: ContinuationHistoryBlock | null) => {
    if (!block) return;
    const cost = providerHandoffBlockBytes(block);
    if (cost > remaining) return;
    blocks.push(block);
    remaining -= cost;
  };
  if (input.route) append(providerHandoffFilesBlock(database, input.threadId, input.route));
  const lastTurn = [...selected.items].reverse().find(({ turnId }) => turnId !== null)?.turnId;
  const commands = lastTurn ? lastTurnCommands(database, lastTurn) : [];
  const moved = input.route?.handoff ? providerHandoffReason(database, input.threadId,
    input.route.handoff.before, input.route.handoff.providerId) : null;
  if (moved || commands.length) append({ label: "Handoff outcome", optional: true, structured: true,
    content: JSON.stringify({ ...(moved ? { moved } : {}), ...(commands.length ? { commands } : {}) }) });
  for (const block of sentReferenceBlocks(references, new Set(selected.items.map(({ id }) => id)), remaining)) append(block);
  return { blocks,
    messageCount: selected.items.length, omittedMessageCount: selected.omittedCount,
    withheldMessageCount: source.withheldCount, selection: selected };
}
