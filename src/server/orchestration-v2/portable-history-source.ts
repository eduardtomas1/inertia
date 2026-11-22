import type Database from "better-sqlite3";

import type { ProviderId } from "../../shared/contracts";
import { readBoundedMessageText } from "../persistence/bounded-message-text";
import {
  continuationRouteSql, continuationRouteTurnSql, type ContinuationRouteFilter,
} from "../persistence/conversation-context-source";
import { boundedSubagentText } from "../provider/subagent-trace";
import { neutralizeUntrustedAgentText } from "../runtime/untrusted-agent-text";
import { WATCHER_NOTE_HISTORY_LABELS } from "../../shared/watcher";
import { sentConversationContextReferences } from "../persistence/conversation-context-packet-repository";
import { sentReferenceBlocks, type ContinuationHistoryBlock } from "../persistence/continuation-history";
import { RESTORED_CHAT_HISTORY_LABEL } from "../persistence/conversation-context-transport";
import { providerHandoffBlockBytes } from "../persistence/provider-handoff-files";
import type { AgentPlanRow } from "../persistence/rows";
import {
  portableCommandText, portableErrorText, portableFileChangeText, portableInterruptText, portablePlanText,
  providerHandoffReason,
} from "../persistence/turn-context-facts";
import { forkHistoryPartSchema } from "../../shared/orchestration-forks";
import { MAX_FORK_ITEM_PARTS, boundedHistoryCandidates, forkItemText, portableForkHistory } from "./portable-fork-history";
import { coveredHistoryOccupancy } from "./portable-history-occupancy";
import {
  MAX_PORTABLE_HISTORY_BUDGET, MAX_PORTABLE_HISTORY_CANDIDATES,
  portableHistoryBudget, selectPortableHistory, type PortableHistoryItem,
} from "./portable-history";

type SourceKind = "message" | "activity" | "plan" | "files" | "interrupt";

interface SourceRow {
  source: SourceKind;
  key: string;
  id: string;
  turn_id: string | null;
  at: string;
  source_order: number;
  position: number;
  kind: string;
}

interface TurnFacts { run_id: string; status: string; provider_id: ProviderId; terminal_reason: string | null }

const TERMINAL_TURN_STATUSES = "('completed','failed','cancelled','interrupted')";
const COVERED = "(SELECT value FROM json_each(?))";
/**
 * A follow-up its provider never read waits in the queue to be its own turn's prompt; until then no turn carries
 * it as history.
 */
const NOT_QUEUED = `messages.id NOT IN (SELECT user_message_id FROM queued_messages
  WHERE conversation_id = messages.conversation_id AND state IN ('waiting','dispatching','blocked')
    AND user_message_id IS NOT NULL)`;

function turnItemStatus(status: string | null): PortableHistoryItem["status"] {
  return status === "failed" || status === "cancelled" || status === "interrupted"
    ? status : status === null || status === "completed" ? "completed" : "partial";
}

function candidateIndex(input: {
  threadId: string;
  excludedMessageId?: string;
  route?: ContinuationRouteFilter;
}, excluded: string) {
  const route = continuationRouteSql(input.route);
  const retained = `(messages.turn_id IS NULL OR messages.turn_id NOT IN (SELECT id FROM orchestration_v2_entities
    WHERE kind = 'rolled-back-turn' AND thread_id = messages.conversation_id))`;
  const messageWhere = `messages.conversation_id = ? AND messages.role IN ('user','assistant')
    AND messages.id <> ? ${route.sql} AND ${retained} AND ${NOT_QUEUED}`;
  const messageParameters = [input.threadId, input.excludedMessageId ?? "", ...route.parameters];
  const routeTurn = input.route ? continuationRouteTurnSql("item_turn", input.route) : { sql: "1", parameters: [] };
  const attached = (column: string) => ({
    sql: `${column} IS NOT NULL AND EXISTS (SELECT 1 FROM agent_turns AS item_turn WHERE item_turn.id = ${column}
        AND item_turn.conversation_id = ? AND item_turn.status IN ${TERMINAL_TURN_STATUSES} AND ${routeTurn.sql}
        AND item_turn.id NOT IN (SELECT id FROM orchestration_v2_entities
          WHERE kind = 'rolled-back-turn' AND thread_id = item_turn.conversation_id))
      AND NOT EXISTS (SELECT 1 FROM messages AS covered WHERE covered.turn_id = ${column} AND covered.id IN ${COVERED})`,
    parameters: [input.threadId, ...routeTurn.parameters, excluded],
  });
  const activity = attached("activities.turn_id");
  const plan = attached("agent_plans.turn_id");
  const files = attached("artifact.turn_id");
  const interrupt = attached("agent_turns.id");
  const sources: { source: SourceKind; keyColumn: string; sql: string; parameters: (string | null)[] }[] = [
    { source: "message", keyColumn: "messages.id", sql: `SELECT 'message' AS source, messages.id AS key, messages.id AS id, messages.turn_id AS turn_id,
        messages.created_at AS at, 0 AS source_order, messages.rowid AS position, messages.role AS kind
        FROM messages WHERE ${messageWhere} AND messages.id NOT IN ${COVERED}`,
    parameters: [...messageParameters, excluded] },
    { source: "activity", keyColumn: "activities.id", sql: `SELECT 'activity' AS source, activities.id AS key, 'activity:' || activities.id AS id,
        activities.turn_id AS turn_id, activities.created_at AS at, 1 AS source_order, activities.rowid AS position,
        activities.kind AS kind FROM activities
        WHERE activities.conversation_id = ? AND activities.kind IN ('command','error') AND activities.status <> 'running'
          AND ${activity.sql} AND ('activity:' || activities.id) NOT IN ${COVERED}`,
    parameters: [input.threadId, ...activity.parameters, excluded] },
    { source: "plan", keyColumn: "agent_plans.run_id", sql: `SELECT 'plan' AS source, agent_plans.run_id AS key, 'plan:' || agent_plans.run_id AS id,
        agent_plans.turn_id AS turn_id, agent_plans.updated_at AS at, 2 AS source_order, agent_plans.rowid AS position,
        'plan' AS kind FROM agent_plans
        WHERE agent_plans.conversation_id = ? AND ${plan.sql} AND ('plan:' || agent_plans.run_id) NOT IN ${COVERED}`,
    parameters: [input.threadId, ...plan.parameters, excluded] },
    { source: "files", keyColumn: "artifact.id", sql: `SELECT 'files' AS source, artifact.id AS key, 'files:' || artifact.id AS id,
        artifact.turn_id AS turn_id, artifact.updated_at AS at, 3 AS source_order, artifact.rowid AS position,
        'file-change' AS kind FROM turn_git_artifacts AS artifact
        WHERE artifact.conversation_id = ? AND artifact.status IN ('ready','partial')
          AND (CASE WHEN json_valid(artifact.files_json) THEN json_array_length(artifact.files_json) ELSE 0 END) > 0
          AND EXISTS (SELECT 1 FROM agent_turns AS owner WHERE owner.id = artifact.turn_id AND owner.association = 'authoritative')
          AND ${files.sql} AND ('files:' || artifact.id) NOT IN ${COVERED}`,
    parameters: [input.threadId, ...files.parameters, excluded] },
    { source: "interrupt", keyColumn: "agent_turns.id", sql: `SELECT 'interrupt' AS source, agent_turns.id AS key, 'interrupt:' || agent_turns.id AS id,
        agent_turns.id AS turn_id, COALESCE(agent_turns.completed_at, agent_turns.updated_at) AS at, 4 AS source_order,
        agent_turns.rowid AS position, agent_turns.status AS kind FROM agent_turns
        WHERE agent_turns.conversation_id = ? AND agent_turns.status IN ('cancelled','interrupted')
          AND agent_turns.started_at IS NOT NULL AND ${interrupt.sql} AND ('interrupt:' || agent_turns.id) NOT IN ${COVERED}`,
    parameters: [input.threadId, ...interrupt.parameters, excluded] },
  ];
  return { sql: sources.map(({ sql }) => sql).join(" UNION ALL "), parameters: sources.flatMap(({ parameters }) => parameters),
    sources, messageWhere, messageParameters, retained };
}

type SourceContent = Pick<PortableHistoryItem, "kind" | "status" | "text">;

function activityContent(database: Database.Database, row: SourceRow, turn: TurnFacts | undefined): SourceContent | null {
  if (row.source === "activity") {
    const activity = database.prepare("SELECT kind, title, detail, status FROM activities WHERE id = ?").get(row.key) as
      { kind: string; title: string; detail: string | null; status: string } | undefined;
    if (!activity || !turn) return null;
    if (activity.kind === "command") {
      return { kind: "command", status: activity.status === "completed" ? "completed" : "failed",
        text: portableCommandText(turn.provider_id, activity) };
    }
    const text = portableErrorText(activity.title);
    return text === null ? null : { kind: "error", status: "failed", text };
  }
  if (row.source === "plan") {
    const plan = database.prepare(`SELECT conversation_id, run_id, turn_id, explanation, steps_json,
      length(CAST(COALESCE(explanation, '') AS BLOB)) + length(CAST(steps_json AS BLOB)) AS bytes
      FROM agent_plans WHERE run_id = ? AND turn_id = ?`).get(row.key, row.turn_id) as AgentPlanRow & { bytes: number } | undefined;
    const text = plan && plan.bytes <= MAX_PORTABLE_HISTORY_BUDGET ? portablePlanText(plan) : null;
    return text === null ? null : { kind: "plan", status: turnItemStatus(turn?.status ?? null), text };
  }
  if (row.source === "files") {
    const artifact = database.prepare("SELECT files_json, status FROM turn_git_artifacts WHERE id = ?").get(row.key) as
      { files_json: string; status: string } | undefined;
    const text = artifact ? portableFileChangeText(artifact.files_json) : null;
    return text === null ? null : { kind: "file-change", status: artifact?.status === "partial" ? "partial" : "completed", text };
  }
  return turn && (turn.status === "cancelled" || turn.status === "interrupted")
    ? { kind: "interrupt-result", status: turn.status, text: portableInterruptText(turn.status, turn.terminal_reason) } : null;
}

function runBackings(database: Database.Database, threadId: string, runIds: readonly string[]): Map<string, string> {
  const rows = database.prepare(`SELECT json_extract(payload_json, '$.runId') AS run_id,
      json_extract(payload_json, '$.backing.id') AS backing_id
    FROM orchestration_v2_events WHERE thread_id = ? AND type = 'provider.backing-recorded'
      AND json_extract(payload_json, '$.runId') IN ${COVERED} ORDER BY sequence`)
    .all(threadId, JSON.stringify(runIds)) as { run_id: string; backing_id: string | null }[];
  const backings = new Map<string, string>();
  for (const { run_id: runId, backing_id: backingId } of rows) if (backingId) backings.set(runId, backingId);
  return backings;
}

function turnOrdinals(database: Database.Database, threadId: string, turnIds: readonly string[]): Map<string, number> {
  const rows = database.prepare(`SELECT id, ordinal FROM (SELECT id,
      row_number() OVER (ORDER BY requested_at, rowid) AS ordinal FROM agent_turns WHERE conversation_id = ?)
    WHERE id IN ${COVERED}`).all(threadId, JSON.stringify(turnIds)) as { id: string; ordinal: number }[];
  return new Map(rows.map(({ id, ordinal }) => [id, ordinal]));
}

/** Read bounded candidates without SQL string aggregation or clipping individual messages. */
export function portableHistorySource(database: Database.Database, input: {
  threadId: string;
  excludedMessageId?: string;
  excludedItemIds?: readonly string[];
  route?: ContinuationRouteFilter;
}) {
  if ((input.excludedItemIds?.length ?? 0) > 2_048) throw new Error("Too many covered history items.");
  const excluded = JSON.stringify(input.excludedItemIds ?? []);
  const index = candidateIndex(input, excluded);
  const count = (sql: string, values: Array<string | null>) =>
    (database.prepare(`SELECT count(*) AS count FROM ${sql}`).get(...values) as { count: number }).count;
  const eligible = count(`(${index.sql})`, index.parameters);
  const routedCount = count(`messages WHERE ${index.messageWhere}`, index.messageParameters);
  const total = count(`messages WHERE messages.conversation_id = ? AND messages.role IN ('user','assistant')
    AND messages.id <> ? AND ${index.retained} AND ${NOT_QUEUED}`, index.messageParameters.slice(0, 2));
  const select = `SELECT * FROM (${index.sql})`;
  // Reserve places for opening/latest user and latest assistant even in a long stream of updates.
  const rows = database.prepare(`${select} ORDER BY at DESC, source_order DESC, position DESC LIMIT ?`)
    .all(...index.parameters, MAX_PORTABLE_HISTORY_CANDIDATES - 3) as SourceRow[];
  for (const [role, direction] of [["user", "ASC"], ["user", "DESC"], ["assistant", "DESC"]] as const) {
    const row = database.prepare(`${select} WHERE source = 'message' AND kind = ?
      ORDER BY at ${direction}, position ${direction} LIMIT 1`)
      .get(...index.parameters, role) as SourceRow | undefined;
    if (row && !rows.some(({ id }) => id === row.id)) rows.push(row);
  }
  rows.sort((left, right) => left.at.localeCompare(right.at, "en")
    || left.source_order - right.source_order || left.position - right.position);
  const prefix = database.prepare("SELECT substr(CAST(content AS BLOB), 1, ?) AS content FROM messages WHERE id = ?");
  const chunks = database.prepare(`SELECT substr(CAST(content AS BLOB), 1, ?) AS content
    FROM message_content_chunks WHERE message_id = ? ORDER BY sequence LIMIT ?`);
  const turnFacts = database.prepare("SELECT run_id, status, provider_id, terminal_reason FROM agent_turns WHERE id = ?");
  const turns = new Map<string, TurnFacts | undefined>();
  const turnOf = (turnId: string | null) => {
    if (turnId === null) return undefined;
    if (!turns.has(turnId)) turns.set(turnId, turnFacts.get(turnId) as TurnFacts | undefined);
    return turns.get(turnId);
  };
  const items: PortableHistoryItem[] = [];
  for (const row of rows) {
    const turn = turnOf(row.turn_id);
    let content: SourceContent | null;
    if (row.source === "message") {
      const value = prefix.get(MAX_PORTABLE_HISTORY_BUDGET + 1, row.key) as { content: Buffer | null };
      const text = readBoundedMessageText(value.content ?? Buffer.alloc(0), () => chunks.iterate(
        MAX_PORTABLE_HISTORY_BUDGET + 1, row.key, MAX_PORTABLE_HISTORY_BUDGET + 1,
      ) as Iterable<{ content: Buffer }>, MAX_PORTABLE_HISTORY_BUDGET);
      if (text.truncated) continue;
      // Preserve complete content except mandatory secret redaction and instruction delimiters.
      content = { kind: row.kind === "user" ? "user-message" : "assistant-message", status: turnItemStatus(turn?.status ?? null),
        text: neutralizeUntrustedAgentText(boundedSubagentText(text.content, text.content.length) ?? "") };
    } else {
      content = activityContent(database, row, turn);
    }
    if (content === null || Buffer.byteLength(content.text) > MAX_PORTABLE_HISTORY_BUDGET) continue;
    items.push({ id: row.id, threadId: input.threadId, turnId: row.turn_id, runId: turn?.run_id ?? null,
      providerBackingId: null, role: content.kind === "user-message" ? "user" : "assistant", ...content, at: row.at });
  }
  const backings = runBackings(database, input.threadId, [...new Set(items.flatMap(({ runId }) => runId ? [runId] : []))]);
  for (const item of items) item.providerBackingId = item.runId ? backings.get(item.runId) ?? null : null;
  const inherited = portableForkHistory(database, input.threadId, input.excludedItemIds ?? []);
  const combined = [...inherited.items, ...items];
  const bounded = boundedHistoryCandidates(combined);
  const eligibleMessages = count(`messages WHERE ${index.messageWhere} AND messages.id NOT IN ${COVERED}`,
    [...index.messageParameters, excluded]);
  return { items: bounded, omittedCount: eligible - items.length + inherited.omittedCount + combined.length - bounded.length,
    activityOmittedCount: eligible - eligibleMessages - bounded.filter(isActivityItem).length,
    withheldCount: total - routedCount,
    turnOrdinals: turnOrdinals(database, input.threadId, [...new Set(items.flatMap(({ turnId }) => turnId ? [turnId] : []))]) };
}

export type PortableHistoryItemRead =
  | { found: true; item: Omit<PortableHistoryItem, "text" | "references" | "origin">; text: string; truncated: boolean }
  | { found: false; reason: "not-found" | "withheld" };

/**
 * One portable history item of this chat by its handoff id, for the
 * item-scoped retrieval hint (T3 `9f1e97de6`). Eligibility is the handoff
 * source's own: the chat's messages and terminal-turn activity outside
 * rolled-back turns, on the reader's route, plus the chat's inherited fork
 * snapshot. Any other id, including another chat's, reads as not found.
 */
export function portableHistoryItem(database: Database.Database, input: {
  threadId: string;
  itemId: string;
  route?: ContinuationRouteFilter;
  maxTextBytes: number;
}): PortableHistoryItemRead {
  const fork = database.prepare(`SELECT payload_json FROM orchestration_v2_entities WHERE kind = 'fork-history'
      AND thread_id = ? AND id = ? AND json_extract(payload_json, '$.part') = 0
      AND json_extract(payload_json, '$.kind') IN ('user-message','assistant-message','command','file','plan','error')`)
    .get(input.threadId, input.itemId) as { payload_json: string } | undefined;
  if (fork) {
    const first = forkHistoryPartSchema.parse(JSON.parse(fork.payload_json));
    // The same integrity rule as the handoff's inherited items: every part present, and a bounded count.
    const stored = (database.prepare(`SELECT COUNT(*) AS parts FROM orchestration_v2_entities
      WHERE kind = 'fork-history' AND thread_id = ? AND json_extract(payload_json, '$.ordinal') = ?`)
      .get(input.threadId, first.ordinal) as { parts: number }).parts;
    if (stored !== first.parts || first.parts > MAX_FORK_ITEM_PARTS) return { found: false, reason: "not-found" };
    const parts = database.prepare(`SELECT CAST(json_extract(payload_json, '$.text') AS BLOB) AS content
      FROM orchestration_v2_entities WHERE kind = 'fork-history' AND thread_id = ?
        AND json_extract(payload_json, '$.ordinal') = ? ORDER BY json_extract(payload_json, '$.part') LIMIT ?`);
    const read = readBoundedMessageText(Buffer.alloc(0),
      () => parts.iterate(input.threadId, first.ordinal, first.parts) as Iterable<{ content: Buffer }>, input.maxTextBytes);
    return { found: true, truncated: read.truncated, text: forkItemText(first.kind, read.content),
      item: { id: first.id, threadId: input.threadId, sourceThreadId: first.sourceThreadId, runId: first.sourceRunId,
        turnId: first.sourceTurnId, providerBackingId: null, role: first.kind === "user-message" ? "user" : "assistant",
        kind: first.kind === "file" ? "file-change" : first.kind as PortableHistoryItem["kind"], status: first.status,
        at: first.createdAt } };
  }
  // Look the item up by its own key in the one source its id names, never by scanning computed ids.
  const separator = input.itemId.indexOf(":");
  const prefix = separator < 0 ? "message" : input.itemId.slice(0, separator);
  const source: SourceKind = prefix === "activity" || prefix === "plan" || prefix === "files" || prefix === "interrupt"
    ? prefix : "message";
  const key = source === "message" ? input.itemId : input.itemId.slice(separator + 1);
  const find = (route?: ContinuationRouteFilter) => {
    const arm = candidateIndex({ threadId: input.threadId, ...(route ? { route } : {}) }, "[]").sources
      .find((candidate) => candidate.source === source)!;
    return database.prepare(`${arm.sql} AND ${arm.keyColumn} = ? LIMIT 1`).get(...arm.parameters, key) as SourceRow | undefined;
  };
  const row = find(input.route);
  if (!row || row.id !== input.itemId) {
    return { found: false, reason: !row && input.route && find()?.id === input.itemId ? "withheld" : "not-found" };
  }
  const turn = row.turn_id === null ? undefined : database.prepare(
    "SELECT run_id, status, provider_id, terminal_reason FROM agent_turns WHERE id = ?").get(row.turn_id) as TurnFacts | undefined;
  let content: SourceContent | null;
  let truncated = false;
  if (row.source === "message") {
    const value = database.prepare("SELECT substr(CAST(content AS BLOB), 1, ?) AS content FROM messages WHERE id = ?")
      .get(input.maxTextBytes + 1, row.key) as { content: Buffer | null };
    const chunks = database.prepare(`SELECT substr(CAST(content AS BLOB), 1, ?) AS content
      FROM message_content_chunks WHERE message_id = ? ORDER BY sequence`);
    const text = readBoundedMessageText(value.content ?? Buffer.alloc(0),
      () => chunks.iterate(input.maxTextBytes + 1, row.key) as Iterable<{ content: Buffer }>, input.maxTextBytes);
    truncated = text.truncated;
    content = { kind: row.kind === "user" ? "user-message" : "assistant-message", status: turnItemStatus(turn?.status ?? null),
      text: neutralizeUntrustedAgentText(boundedSubagentText(text.content, text.content.length) ?? "") };
  } else {
    content = activityContent(database, row, turn);
  }
  if (content === null) return { found: false, reason: "not-found" };
  const { text, ...facts } = content;
  return { found: true, text, truncated, item: { id: row.id, threadId: input.threadId, turnId: row.turn_id,
    runId: turn?.run_id ?? null, providerBackingId: null, role: content.kind === "user-message" ? "user" : "assistant",
    ...facts, at: row.at } };
}

function isActivityItem(item: PortableHistoryItem): boolean {
  return item.sourceThreadId === undefined && item.kind !== "user-message" && item.kind !== "assistant-message";
}

export function readPortableContinuationHistory(database: Database.Database, input:
  Parameters<typeof portableHistorySource>[1] & {
    capacityBytes: number;
    currentPromptBytes: number;
    imageCount: number;
    otherAttachmentCount?: number;
    modelWindow?: number;
    configuredCap?: number;
    nativeUsedTokens?: number;
    reportedWindow?: number;
    autoCompactThreshold?: number;
    estimateNativeOccupancy?: true;
    hostToolBridgeAttested?: boolean;
  }) {
  const source = portableHistorySource(database, input);
  if (source.items.length === 0 && source.omittedCount === 0 && source.withheldCount === 0) return null;
  const nativeContextEstimate = input.estimateNativeOccupancy && input.nativeUsedTokens === undefined
    ? coveredHistoryOccupancy(database, input.threadId, input.excludedItemIds ?? []) : undefined;
  const budget = Math.min(Math.max(0, input.capacityBytes),
    portableHistoryBudget({ ...input, ...(nativeContextEstimate === undefined ? {} : { nativeContextEstimate }) }));
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
    previouslyOmitted: source.omittedCount, budget, purpose: input.excludedItemIds?.length ? "delta" : "restore",
    turnOrdinals: source.turnOrdinals,
    ...(input.hostToolBridgeAttested === undefined ? {} : { hostToolBridgeAttested: input.hostToolBridgeAttested }) });
  const activityIds = new Set(items.filter(isActivityItem).map(({ id }) => id));
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
  const moved = input.route?.handoff ? providerHandoffReason(database, input.threadId,
    input.route.handoff.before, input.route.handoff.providerId) : null;
  if (moved) append({ label: "Handoff outcome", optional: true, structured: true, content: JSON.stringify({ moved }) });
  for (const block of sentReferenceBlocks(references, new Set(selected.items.map(({ id }) => id)), remaining)) append(block);
  return { blocks,
    messageCount: selected.items.filter((item) => !isActivityItem(item)).length,
    omittedMessageCount: selected.omittedCount - source.activityOmittedCount
      - selected.omittedItemIds.filter((id) => activityIds.has(id)).length,
    withheldMessageCount: source.withheldCount, selection: selected };
}
