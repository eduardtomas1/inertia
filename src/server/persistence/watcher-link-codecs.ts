import type Database from "better-sqlite3";

import { cachedStatement } from "./statement-cache";

import { clipCodeUnits } from "../../shared/code-units";
import {
  clampWatcherBudgets,
  DEFAULT_WATCHER_SHARING,
  MAX_WATCHER_GUARD_PATHS,
  MAX_WATCHER_HEADLINE_CHARS,
  MAX_WATCHER_PAUSE_DETAIL_CHARS,
  MAX_WATCHER_PENDING_RUNNING_IDS,
  watcherLinkViewSchema,
  watcherPrintableText,
  watcherSharingSchema,
  watcherUtf8Bytes,
  type WatcherDelivery,
  type WatcherDeliveryMode,
  type WatcherDeliveryPolicy,
  type WatcherDeliveryState,
  type WatcherDetachReason,
  type WatcherFeedHeadline,
  type WatcherFeedItem,
  type WatcherGuardState,
  type WatcherLinkView,
  type WatcherPauseReason,
  type WatcherPreset,
  type WatcherPrivateConnect,
  type WatcherStatus,
  type WatcherUsage,
  type WatcherWakeOutcome,
  type WatcherWakeState,
  type WatcherWakeSummary,
  type WatcherWakeTrigger,
} from "../../shared/watcher";

export interface WatcherLinkRow {
  id: string;
  watcher_conversation_id: string;
  watched_conversation_id: string | null;
  project_id: string;
  preset: WatcherPreset;
  instructions: string;
  sharing_json: string;
  budgets_json: string;
  private_connect: WatcherPrivateConnect;
  delivery: WatcherDeliveryPolicy;
  read_only: number;
  status: WatcherStatus;
  pause_reason: WatcherPauseReason | null;
  pause_detail: string | null;
  detached_reason: WatcherDetachReason | null;
  cursor_turn_id: string | null;
  cursor_activity_at: string | null;
  cursor_activity_id: string | null;
  cursor_message_at: string | null;
  cursor_message_id: string | null;
  pending_running_ids_json: string;
  wakes_this_turn: number;
  wake_allowance: number;
  write_attempts_this_turn: number;
  wakes_total: number;
  events_seen: number;
  events_pending: number;
  findings_total: number;
  final_pass_turn_id: string | null;
  last_wake_at: string | null;
  last_watched_output_at: string | null;
  quiet_since: string | null;
  feed_revision: number;
  created_at: string;
  updated_at: string;
  latest_outcome?: WatcherWakeOutcome | null;
  latest_at?: string | null;
  latest_finding?: string | null;
  latest_finding_at?: string | null;
}

export interface WatcherWakeRow {
  id: string;
  link_id: string;
  watcher_turn_id: string | null;
  watched_turn_id: string | null;
  sequence: number;
  trigger: WatcherWakeTrigger;
  state: WatcherWakeState;
  outcome: WatcherWakeOutcome | null;
  events_covered: number;
  items_truncated: number;
  items_omitted: number;
  digest_bytes: number;
  guard_state: WatcherGuardState | null;
  guard_paths_json: string;
  finding_preview: string | null;
  delivery_mode: WatcherDeliveryMode | null;
  delivery_state: WatcherDeliveryState | null;
  delivery_detail: string | null;
  delivery_id: string | null;
  delivery_automatic: number;
  delivered_message_id: string | null;
  queued_message_id: string | null;
  delivered_at: string | null;
  created_at: string;
  settled_at: string | null;
  resolved_by_sequence: number | null;
  commands_declined: number;
}

export interface WatcherCursor {
  turnId: string | null;
  activityAt: string | null;
  activityId: string | null;
  messageAt: string | null;
  messageId: string | null;
  pendingRunningIds: string[];
}

export interface WatcherLinkRecord extends WatcherLinkView {
  instructions: string;
  cursor: WatcherCursor;
  writeAttemptsThisTurn: number;
  finalPassTurnId: string | null;
  lastWatchedOutputAt: string | null;
}

export interface WatcherWakeRecord extends WatcherFeedItem {
  linkId: string;
  digestBytes: number;
  deliveryId: string | null;
  deliveredMessageId: string | null;
  queuedMessageId: string | null;
}

export const LATEST_WATCHER_WAKE_SQL = `
  SELECT link.*, latest.outcome AS latest_outcome, latest.settled_at AS latest_at,
    substr(latest.finding_preview, 1, 1024) AS latest_finding,
    (
      SELECT finding.settled_at FROM watcher_wakes AS finding
      WHERE finding.link_id = link.id AND finding.state = 'settled' AND finding.outcome = 'finding'
        AND finding.delivery_state IS NOT 'dismissed'
      ORDER BY finding.sequence DESC LIMIT 1
    ) AS latest_finding_at
  FROM watcher_links AS link
  LEFT JOIN watcher_wakes AS latest ON latest.id = (
    SELECT candidate.id FROM watcher_wakes AS candidate
    WHERE candidate.link_id = link.id AND candidate.state = 'settled'
    ORDER BY candidate.sequence DESC LIMIT 1
  )
`;

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function stringArray(value: string, maximum: number): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0).slice(0, maximum)
    : [];
}

export function truncateUtf8Bytes(value: string, maximumBytes: number): string {
  if (watcherUtf8Bytes(value) <= maximumBytes) return value;
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const size = watcherUtf8Bytes(character);
    if (bytes + size > maximumBytes) break;
    bytes += size;
    end += character.length;
  }
  return value.slice(0, end);
}

export function watcherPrintableLineOf(value: string, maximum: number): string {
  return clipCodeUnits(watcherPrintableText(value).replace(/\s+/gu, " ").trim(), maximum).trim();
}

function headline(row: WatcherLinkRow): WatcherFeedHeadline | null {
  if (!row.latest_outcome || !row.latest_at) return null;
  const text = row.latest_outcome === "finding" && row.latest_finding
    ? watcherPrintableLineOf(row.latest_finding, MAX_WATCHER_HEADLINE_CHARS)
    : "";
  return { outcome: row.latest_outcome, at: row.latest_at, text };
}

export function watcherLinkFromRow(row: WatcherLinkRow): WatcherLinkRecord {
  const sharing = watcherSharingSchema.safeParse(parseJson(row.sharing_json));
  const budgets = parseJson(row.budgets_json);
  return {
    id: row.id,
    watcherConversationId: row.watcher_conversation_id,
    watchedConversationId: row.watched_conversation_id,
    projectId: row.project_id,
    preset: row.preset,
    instructions: row.instructions,
    sharing: sharing.success ? sharing.data : { ...DEFAULT_WATCHER_SHARING },
    budgets: clampWatcherBudgets(typeof budgets === "object" && budgets !== null ? budgets : {}),
    privateConnect: row.private_connect,
    delivery: row.delivery,
    readOnly: row.read_only !== 0,
    status: row.status,
    pauseReason: row.pause_reason,
    pauseDetail: row.pause_detail === null ? null : watcherPrintableLineOf(row.pause_detail, MAX_WATCHER_PAUSE_DETAIL_CHARS) || null,
    detachedReason: row.detached_reason,
    watchedTurnId: row.cursor_turn_id,
    counters: {
      wakesThisTurn: row.wakes_this_turn,
      wakeAllowance: row.wake_allowance,
      wakesTotal: row.wakes_total,
      eventsSeen: row.events_seen,
      eventsPending: row.events_pending,
      findingsTotal: row.findings_total,
    },
    lastWakeAt: row.last_wake_at,
    quietSince: row.quiet_since,
    feedRevision: row.feed_revision,
    latest: headline(row),
    latestFindingAt: row.latest_finding_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cursor: {
      turnId: row.cursor_turn_id,
      activityAt: row.cursor_activity_at,
      activityId: row.cursor_activity_id,
      messageAt: row.cursor_message_at,
      messageId: row.cursor_message_id,
      pendingRunningIds: stringArray(row.pending_running_ids_json, MAX_WATCHER_PENDING_RUNNING_IDS),
    },
    writeAttemptsThisTurn: row.write_attempts_this_turn,
    finalPassTurnId: row.final_pass_turn_id,
    lastWatchedOutputAt: row.last_watched_output_at,
  };
}

function strippedView(record: WatcherLinkRecord): WatcherLinkView & { instructions: string } {
  const {
    cursor: _cursor,
    writeAttemptsThisTurn: _writes,
    finalPassTurnId: _finalPass,
    lastWatchedOutputAt: _lastOutput,
    ...view
  } = record;
  return view;
}

export function watcherLinkView(record: WatcherLinkRecord): WatcherLinkView {
  const { instructions: _instructions, ...view } = strippedView(record);
  return view;
}

export function watcherLinkDetailView(record: WatcherLinkRecord, usage: WatcherUsage): WatcherLinkView {
  return { ...strippedView(record), usage };
}

function delivery(row: WatcherWakeRow): WatcherDelivery | null {
  if (row.delivery_state === null || row.delivered_at === null) return null;
  return {
    mode: row.delivery_mode,
    state: row.delivery_state,
    detail: row.delivery_detail,
    at: row.delivered_at,
    ...(row.delivery_automatic === 1 ? { automatic: true } : {}),
  };
}

export function watcherWakeFromRow(row: WatcherWakeRow): WatcherWakeRecord {
  return {
    wakeId: row.id,
    sequence: row.sequence,
    watcherTurnId: row.watcher_turn_id,
    watchedTurnId: row.watched_turn_id,
    trigger: row.trigger,
    outcome: row.outcome,
    state: row.state,
    eventsCovered: row.events_covered,
    itemsTruncated: row.items_truncated,
    itemsOmitted: row.items_omitted,
    guardState: row.guard_state,
    guardPaths: stringArray(row.guard_paths_json, MAX_WATCHER_GUARD_PATHS),
    finding: row.finding_preview,
    delivery: delivery(row),
    createdAt: row.created_at,
    settledAt: row.settled_at,
    resolvedBySequence: row.resolved_by_sequence,
    commandsDeclined: row.commands_declined,
    linkId: row.link_id,
    digestBytes: row.digest_bytes,
    deliveryId: row.delivery_id,
    deliveredMessageId: row.delivered_message_id,
    queuedMessageId: row.queued_message_id,
  };
}

export function watcherFeedItem(record: WatcherWakeRecord): WatcherFeedItem {
  const {
    linkId: _linkId,
    deliveryId: _deliveryId,
    deliveredMessageId: _deliveredMessageId,
    queuedMessageId: _queuedMessageId,
    ...item
  } = record;
  return item;
}

export function watcherWatchedAccess(
  database: Database.Database,
  targetConversationId: string,
  sourceConversationId: string,
): boolean {
  return cachedStatement(database, `
    SELECT 1 FROM watcher_links AS link
    JOIN conversations AS watcher ON watcher.id = link.watcher_conversation_id
    JOIN conversations AS watched ON watched.id = link.watched_conversation_id
    WHERE link.watcher_conversation_id = ? AND link.watched_conversation_id = ?
      AND link.status <> 'detached'
      AND watcher.project_id = link.project_id AND watched.project_id = link.project_id
    LIMIT 1
  `).get(targetConversationId, sourceConversationId) !== undefined;
}

export function activeWatcherLinks(database: Database.Database): WatcherLinkRecord[] {
  return (cachedStatement(database, `${LATEST_WATCHER_WAKE_SQL}
    WHERE link.status <> 'detached' ORDER BY link.created_at ASC, link.id ASC`)
    .all() as WatcherLinkRow[]).map(watcherLinkFromRow);
}

export function watcherLinkViews(database: Database.Database): WatcherLinkView[] {
  return activeWatcherLinks(database)
    .map(watcherLinkView)
    .filter((view) => watcherLinkViewSchema.safeParse(view).success);
}

export function watcherWakeSummaries(
  database: Database.Database,
  conversationId: string,
  turnIds?: readonly string[],
): WatcherWakeSummary[] | undefined {
  const link = database.prepare("SELECT id FROM watcher_links WHERE watcher_conversation_id = ?")
    .get(conversationId) as { id: string } | undefined;
  if (!link) return undefined;
  const rows = (turnIds === undefined
    ? database.prepare(`
        SELECT wake.* FROM watcher_wakes AS wake
        JOIN agent_turns AS turn ON turn.id = wake.watcher_turn_id AND turn.conversation_id = ?
        WHERE wake.link_id = ? ORDER BY wake.sequence ASC
      `).all(conversationId, link.id)
    : database.prepare(`
        SELECT wake.* FROM watcher_wakes AS wake
        JOIN agent_turns AS turn ON turn.id = wake.watcher_turn_id AND turn.conversation_id = ?
        WHERE wake.link_id = ? AND wake.watcher_turn_id IN (SELECT value FROM json_each(?))
        ORDER BY wake.sequence ASC
      `).all(conversationId, link.id, JSON.stringify(turnIds))) as WatcherWakeRow[];
  return rows.flatMap((row) => row.watcher_turn_id === null ? [] : [{
    wakeId: row.id,
    turnId: row.watcher_turn_id,
    sequence: row.sequence,
    trigger: row.trigger,
    outcome: row.outcome,
    eventsCovered: row.events_covered,
    itemsTruncated: row.items_truncated,
    itemsOmitted: row.items_omitted,
    guardState: row.guard_state,
  }]);
}
