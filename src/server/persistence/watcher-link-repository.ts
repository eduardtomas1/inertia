import type Database from "better-sqlite3";

import { clipCodeUnits } from "../../shared/code-units";
import type { AccessMode, Conversation, InteractionMode } from "../../shared/contracts";
import {
  MAX_ACTIVE_WATCHERS,
  MAX_WATCHER_DELIVERY_DETAIL_CHARS,
  MAX_WATCHER_FEED_PAGE,
  MAX_WATCHER_FINDING_BYTES,
  MAX_WATCHER_GUARD_PATHS,
  MAX_WATCHER_PAUSE_DETAIL_CHARS,
  MAX_WATCHER_PENDING_RUNNING_IDS,
  WATCHER_WAKE_RETENTION,
  watcherBudgetsSchema,
  watcherDeliveryPolicySchema,
  watcherHarnessAllowed,
  watcherInstructionsSchema,
  watcherPresetSchema,
  watcherPrivateConnectSchema,
  watcherSharingSchema,
  type WatcherBudgets,
  type WatcherDeliveryMode,
  type WatcherDeliveryPolicy,
  type WatcherDeliveryState,
  type WatcherDetachReason,
  type WatcherFeedItem,
  type WatcherGuardState,
  type WatcherPauseReason,
  type WatcherPreset,
  type WatcherPrivateConnect,
  type WatcherSharing,
  type WatcherStatus,
  type WatcherUsage,
  type WatcherWakeOutcome,
  type WatcherWakeTrigger,
} from "../../shared/watcher";
import { measuredProcessedTokens } from "../usage-dashboard";
import { requireTimestamp } from "./codecs";
import type { ConversationContextTurnReads } from "./conversation-context-turn-reads";
import type { ConversationRepository } from "./conversation-repository";
import { cachedStatement } from "./statement-cache";
import type { NewConversationOptions } from "./types";
import {
  USAGE_DASHBOARD_TURN_COLUMNS,
  usageDashboardTurnFromRow,
  type UsageDashboardTurnRow,
} from "./usage-dashboard-repository";
import { WatcherDigestSource } from "./watcher-digest-source";
import {
  activeWatcherLinks,
  LATEST_WATCHER_WAKE_SQL,
  truncateUtf8Bytes,
  watcherFeedItem,
  watcherPrintableLineOf,
  watcherLinkFromRow,
  watcherWakeFromRow,
  type WatcherCursor,
  type WatcherLinkRecord,
  type WatcherLinkRow,
  type WatcherWakeRecord,
  type WatcherWakeRow,
} from "./watcher-link-codecs";

export type { WatcherCursor, WatcherLinkRecord, WatcherWakeRecord } from "./watcher-link-codecs";

export class WatcherPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatcherPolicyError";
  }
}

export interface WatcherLinkDraft {
  id: string;
  watchedConversationId: string;
  preset: WatcherPreset;
  instructions: string;
  sharing: WatcherSharing;
  budgets: WatcherBudgets;
  privateConnect: WatcherPrivateConnect;
  delivery?: WatcherDeliveryPolicy;
}

interface WatcherConversationPlan {
  projectId: string;
  title: string;
  options: NewConversationOptions;
}

export type WatcherTransition =
  | { status: Exclude<WatcherStatus, "paused" | "detached"> }
  | { status: "paused"; reason: WatcherPauseReason; detail?: string | null }
  | { status: "detached"; reason: WatcherDetachReason };

interface WatcherSettingsPatch {
  preset?: WatcherPreset;
  instructions?: string;
  sharing?: WatcherSharing;
  budgets?: WatcherBudgets;
  privateConnect?: WatcherPrivateConnect;
  delivery?: WatcherDeliveryPolicy;
}

interface WatcherWakeDraft {
  id: string;
  linkId: string;
  watchedTurnId: string | null;
  trigger: WatcherWakeTrigger;
  eventsCovered: number;
  itemsTruncated: number;
  itemsOmitted: number;
  digestBytes: number;
  consumesAllowance?: boolean;
}

interface WatcherGuardResult {
  state: WatcherGuardState;
  paths: readonly string[];
}

interface WatcherDeliveryUpdate {
  mode: WatcherDeliveryMode | null;
  state: WatcherDeliveryState;
  detail?: string | null;
  deliveryId?: string | null;
  deliveredMessageId?: string | null;
  queuedMessageId?: string | null;
}

export interface WatcherFeedPage {
  linkId: string;
  feedRevision: number;
  items: WatcherFeedItem[];
  next: { beforeSequence: number } | null;
}

interface WatcherRunConfiguration {
  interactionMode: InteractionMode;
  accessMode: AccessMode;
  harnessId: string;
}

interface WatcherLinkRepositoryContext {
  database: Database.Database;
  conversations: ConversationRepository;
  turnReads(): Pick<ConversationContextTurnReads, "messageText" | "files">;
}

export const WATCHER_ARCHIVED_REFUSAL = "Archived chats can't be watched.";
export const WATCHER_OF_WATCHER_REFUSAL = "A watcher can't watch another watcher.";
export const WATCHER_LIMIT_REFUSAL = `Inertia already has ${MAX_ACTIVE_WATCHERS} active watchers. Stop one first.`;
const TERMINAL_TURN_STATUSES_SQL = "('completed', 'failed', 'cancelled', 'interrupted')";
const MAX_RETIRED_WAKES_PER_CHECK = 4;
const ACTIVE_WAKE_STATES_SQL = "('dispatching', 'running')";
const DELIVERY_TRANSITIONS: Readonly<Record<WatcherDeliveryState | "none", readonly WatcherDeliveryState[]>> = {
  none: ["queued", "sent", "dismissed", "failed"],
  failed: ["queued", "sent", "dismissed", "failed"],
  queued: ["sent", "failed"],
  sent: [],
  dismissed: [],
};

function boundedCount(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function boundedGuardPaths(paths: readonly string[]): string {
  const kept: string[] = [];
  for (const path of paths) {
    if (kept.length >= MAX_WATCHER_GUARD_PATHS) break;
    if (typeof path !== "string" || path.length === 0 || path.length > 4_096) continue;
    if (Buffer.byteLength(JSON.stringify([...kept, path]), "utf8") > 8_192) break;
    kept.push(path);
  }
  return JSON.stringify(kept);
}

export class WatcherLinkRepository {
  readonly digest: WatcherDigestSource;
  private readonly database: Database.Database;

  constructor(private readonly context: WatcherLinkRepositoryContext) {
    this.database = context.database;
    this.digest = new WatcherDigestSource({ database: context.database, turnReads: context.turnReads });
  }

  createWithConversation(
    input: { link: WatcherLinkDraft; conversation: WatcherConversationPlan },
    now: string,
  ): { link: WatcherLinkRecord; conversation: Conversation; created: boolean } {
    const at = requireTimestamp(now, "Watcher creation time");
    const draft = {
      preset: watcherPresetSchema.parse(input.link.preset),
      instructions: watcherInstructionsSchema.parse(input.link.instructions),
      sharing: watcherSharingSchema.parse(input.link.sharing),
      budgets: watcherBudgetsSchema.parse(input.link.budgets),
      privateConnect: watcherPrivateConnectSchema.parse(input.link.privateConnect),
      delivery: watcherDeliveryPolicySchema.parse(input.link.delivery ?? "manual"),
    };
    return this.database.transaction(() => {
      const existing = this.get(input.link.id);
      if (existing) {
        if (existing.watchedConversationId !== input.link.watchedConversationId || existing.status === "detached") {
          throw new WatcherPolicyError("This watcher already exists.");
        }
        return { link: existing, conversation: this.context.conversations.get(existing.watcherConversationId), created: false };
      }
      const watched = this.database.prepare("SELECT id, project_id, archived_at FROM conversations WHERE id = ?")
        .get(input.link.watchedConversationId) as { id: string; project_id: string; archived_at: string | null } | undefined;
      if (!watched) throw new WatcherPolicyError("The chat to watch no longer exists.");
      if (watched.archived_at !== null) throw new WatcherPolicyError(WATCHER_ARCHIVED_REFUSAL);
      if (watched.project_id !== input.conversation.projectId) {
        throw new WatcherPolicyError("A watcher must belong to the main chat's project.");
      }
      const watchedPolicy = this.policyForConversation(watched.id);
      if (watchedPolicy && watchedPolicy.status !== "detached") {
        throw new WatcherPolicyError(WATCHER_OF_WATCHER_REFUSAL);
      }
      if (this.findActiveByWatched(watched.id)) {
        throw new WatcherPolicyError("This chat already has a watcher.");
      }
      const { active } = this.database.prepare("SELECT COUNT(*) AS active FROM watcher_links WHERE status <> 'detached'")
        .get() as { active: number };
      if (active >= MAX_ACTIVE_WATCHERS) {
        throw new WatcherPolicyError(WATCHER_LIMIT_REFUSAL);
      }
      const conversation = this.context.conversations.create(
        input.conversation.projectId,
        input.conversation.title,
        { ...input.conversation.options, activate: false },
      );
      this.database.prepare("INSERT OR IGNORE INTO conversation_title_locks (conversation_id) VALUES (?)")
        .run(conversation.id);
      this.database.prepare(`
        INSERT INTO watcher_links (
          id, watcher_conversation_id, watched_conversation_id, project_id, preset, instructions,
          sharing_json, budgets_json, private_connect, delivery, status, wake_allowance, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'watching', ?, ?, ?)
      `).run(
        input.link.id, conversation.id, watched.id, watched.project_id, draft.preset, draft.instructions,
        JSON.stringify(draft.sharing), JSON.stringify(draft.budgets), draft.privateConnect, draft.delivery,
        draft.budgets.wakesPerWatchedTurn, at, at,
      );
      return { link: this.require(input.link.id), conversation, created: true };
    })();
  }

  get(linkId: string): WatcherLinkRecord | null {
    const row = cachedStatement(this.database, `${LATEST_WATCHER_WAKE_SQL} WHERE link.id = ?`)
      .get(linkId) as WatcherLinkRow | undefined;
    return row ? watcherLinkFromRow(row) : null;
  }

  findByWatcher(conversationId: string): WatcherLinkRecord | null {
    const row = cachedStatement(this.database, `${LATEST_WATCHER_WAKE_SQL} WHERE link.watcher_conversation_id = ?`)
      .get(conversationId) as WatcherLinkRow | undefined;
    return row ? watcherLinkFromRow(row) : null;
  }

  findActiveByWatched(conversationId: string): WatcherLinkRecord | null {
    const row = cachedStatement(this.database, `${LATEST_WATCHER_WAKE_SQL}
      WHERE link.watched_conversation_id = ? AND link.status <> 'detached'`)
      .get(conversationId) as WatcherLinkRow | undefined;
    return row ? watcherLinkFromRow(row) : null;
  }

  parentForWatcher(conversationId: string): { watchedConversationId: string | null; privateConnect: WatcherPrivateConnect } | null {
    const row = cachedStatement(this.database, `
      SELECT watched_conversation_id, private_connect FROM watcher_links
      WHERE watcher_conversation_id = ? AND status <> 'detached'
    `).get(conversationId) as { watched_conversation_id: string | null; private_connect: WatcherPrivateConnect } | undefined;
    return row ? { watchedConversationId: row.watched_conversation_id, privateConnect: row.private_connect } : null;
  }

  watcherTurnActiveFor(watchedConversationId: string): boolean {
    return cachedStatement(this.database, `
      SELECT 1 FROM watcher_links AS link
      JOIN agent_turns AS turn ON turn.conversation_id = link.watcher_conversation_id
      WHERE link.watched_conversation_id = ? AND link.status <> 'detached'
        AND turn.status NOT IN ${TERMINAL_TURN_STATUSES_SQL}
      LIMIT 1
    `).get(watchedConversationId) !== undefined;
  }

  active(): WatcherLinkRecord[] {
    return activeWatcherLinks(this.database);
  }

  transition(
    linkId: string,
    expected: readonly WatcherStatus[],
    next: WatcherTransition,
    now: string,
  ): WatcherLinkRecord | null {
    const at = requireTimestamp(now, "Watcher transition time");
    const from = next.status === "detached" ? expected : expected.filter((status) => status !== "detached");
    if (from.length === 0) return null;
    const paused = next.status === "paused" ? next : null;
    const detached = next.status === "detached" ? next : null;
    const changed = this.database.prepare(`
      UPDATE watcher_links
      SET status = ?, pause_reason = ?, pause_detail = ?, detached_reason = ?, updated_at = ?
      WHERE id = ? AND status IN (SELECT value FROM json_each(?))
    `).run(
      next.status,
      paused?.reason ?? null,
      paused?.detail ? watcherPrintableLineOf(paused.detail, MAX_WATCHER_PAUSE_DETAIL_CHARS) || null : null,
      detached?.reason ?? null,
      at,
      linkId,
      JSON.stringify(from),
    ).changes;
    return changed === 1 ? this.get(linkId) : null;
  }

  updateSettings(linkId: string, patch: WatcherSettingsPatch, now: string): WatcherLinkRecord | null {
    const at = requireTimestamp(now, "Watcher update time");
    const values = {
      preset: patch.preset === undefined ? null : watcherPresetSchema.parse(patch.preset),
      instructions: patch.instructions === undefined ? null : watcherInstructionsSchema.parse(patch.instructions),
      sharing: patch.sharing === undefined ? null : JSON.stringify(watcherSharingSchema.parse(patch.sharing)),
      budgets: patch.budgets === undefined ? null : JSON.stringify(watcherBudgetsSchema.parse(patch.budgets)),
      privateConnect: patch.privateConnect === undefined ? null : watcherPrivateConnectSchema.parse(patch.privateConnect),
      delivery: patch.delivery === undefined ? null : watcherDeliveryPolicySchema.parse(patch.delivery),
    };
    const changed = this.database.prepare(`
      UPDATE watcher_links
      SET preset = COALESCE(@preset, preset),
          instructions = COALESCE(@instructions, instructions),
          sharing_json = COALESCE(@sharing, sharing_json),
          budgets_json = COALESCE(@budgets, budgets_json),
          private_connect = COALESCE(@privateConnect, private_connect),
          delivery = COALESCE(@delivery, delivery),
          updated_at = @at
      WHERE id = @linkId AND status <> 'detached'
    `).run({ ...values, at, linkId }).changes;
    return changed === 1 ? this.get(linkId) : null;
  }

  beginWatchedTurn(linkId: string, turnId: string, now: string): WatcherLinkRecord | null {
    const at = requireTimestamp(now, "Watched turn start time");
    return this.database.transaction(() => {
      const link = this.get(linkId);
      if (!link || link.status === "detached") return null;
      if (link.cursor.turnId === turnId) return link;
      this.database.prepare(`
        UPDATE watcher_links
        SET cursor_turn_id = ?, cursor_activity_at = NULL, cursor_activity_id = NULL,
            cursor_message_at = NULL, cursor_message_id = NULL, pending_running_ids_json = '[]',
            wakes_this_turn = 0, wake_allowance = ?, write_attempts_this_turn = 0,
            last_watched_output_at = ?, quiet_since = NULL, updated_at = ?,
            status = CASE WHEN status = 'paused' AND pause_reason = 'wake-budget' THEN 'watching' ELSE status END,
            pause_detail = CASE WHEN status = 'paused' AND pause_reason = 'wake-budget' THEN NULL ELSE pause_detail END,
            pause_reason = CASE WHEN status = 'paused' AND pause_reason = 'wake-budget' THEN NULL ELSE pause_reason END
        WHERE id = ?
      `).run(turnId, link.budgets.wakesPerWatchedTurn, at, at, linkId);
      return this.require(linkId);
    })();
  }

  advanceCursor(
    linkId: string,
    cursor: WatcherCursor,
    eventsDelta: number,
    now: string,
    expectedTurnId: string | null = cursor.turnId,
  ): WatcherLinkRecord | null {
    const at = requireTimestamp(now, "Watcher cursor time");
    const delta = boundedCount(eventsDelta);
    const pending = [...new Set(cursor.pendingRunningIds)].slice(0, MAX_WATCHER_PENDING_RUNNING_IDS);
    return this.database.transaction(() => {
      const moved = this.database.prepare(`
        UPDATE watcher_links
        SET cursor_turn_id = ?, cursor_activity_at = ?, cursor_activity_id = ?, cursor_message_at = ?,
            cursor_message_id = ?, pending_running_ids_json = ?, events_seen = events_seen + ?, updated_at = ?
        WHERE id = ? AND status <> 'detached' AND (cursor_turn_id IS ? OR cursor_turn_id IS ?)
      `).run(
        cursor.turnId, cursor.activityAt, cursor.activityId, cursor.messageAt, cursor.messageId,
        JSON.stringify(pending), delta, at, linkId, expectedTurnId, cursor.turnId,
      ).changes;
      if (moved === 1) return this.get(linkId);
      const counted = this.database.prepare(`
        UPDATE watcher_links SET events_seen = events_seen + ?, updated_at = ?
        WHERE id = ? AND status <> 'detached'
      `).run(delta, at, linkId).changes;
      return counted === 1 ? this.get(linkId) : null;
    })();
  }

  notePendingEvents(linkId: string, pending: number, now: string): WatcherLinkRecord | null {
    const at = requireTimestamp(now, "Watcher event time");
    const count = boundedCount(pending);
    const changed = cachedStatement(this.database, `
      UPDATE watcher_links SET events_pending = ?, updated_at = ?
      WHERE id = ? AND status <> 'detached' AND events_pending <> ?
    `).run(count, at, linkId, count).changes;
    return changed === 1 ? this.get(linkId) : null;
  }

  recordWatchedOutput(linkId: string, at: string): void {
    const timestamp = requireTimestamp(at, "Watched output time");
    this.database.prepare(`
      UPDATE watcher_links SET last_watched_output_at = ?, quiet_since = NULL
      WHERE id = ? AND status <> 'detached'
    `).run(timestamp, linkId);
  }

  markQuiet(linkId: string, now: string): WatcherLinkRecord | null {
    const at = requireTimestamp(now, "Watcher quiet time");
    const changed = this.database.prepare(`
      UPDATE watcher_links SET quiet_since = COALESCE(last_watched_output_at, ?), updated_at = ?
      WHERE id = ? AND status <> 'detached' AND quiet_since IS NULL
    `).run(at, at, linkId).changes;
    return changed === 1 ? this.get(linkId) : null;
  }

  markFinalPass(linkId: string, turnId: string, now: string): boolean {
    const at = requireTimestamp(now, "Watcher final pass time");
    return this.database.prepare(`
      UPDATE watcher_links SET final_pass_turn_id = ?, updated_at = ?
      WHERE id = ? AND status <> 'detached' AND final_pass_turn_id IS NOT ?
    `).run(turnId, at, linkId, turnId).changes === 1;
  }

  grantWakes(linkId: string, count: number, now = new Date().toISOString()): WatcherLinkRecord | null {
    const at = requireTimestamp(now, "Watcher grant time");
    const changed = this.database.prepare(`
      UPDATE watcher_links SET wake_allowance = wake_allowance + ?, updated_at = ?
      WHERE id = ? AND status <> 'detached'
    `).run(boundedCount(count), at, linkId).changes;
    return changed === 1 ? this.get(linkId) : null;
  }

  recordWriteAttempt(linkId: string, now = new Date().toISOString()): number {
    const at = requireTimestamp(now, "Watcher attempt time");
    const row = this.database.prepare(`
      UPDATE watcher_links SET write_attempts_this_turn = write_attempts_this_turn + 1, updated_at = ?
      WHERE id = ? AND status <> 'detached'
      RETURNING write_attempts_this_turn AS count
    `).get(at, linkId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  createWake(draft: WatcherWakeDraft, now: string): WatcherWakeRecord | null {
    const at = requireTimestamp(now, "Watcher check time");
    return this.database.transaction(() => {
      const link = this.database.prepare("SELECT status FROM watcher_links WHERE id = ?")
        .get(draft.linkId) as { status: WatcherStatus } | undefined;
      if (link?.status !== "waking") return null;
      const inFlight = this.database.prepare(`
        SELECT 1 FROM watcher_wakes WHERE link_id = ? AND state IN ${ACTIVE_WAKE_STATES_SQL} LIMIT 1
      `).get(draft.linkId);
      if (inFlight) return null;
      const { sequence } = this.database.prepare(`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM watcher_wakes WHERE link_id = ?
      `).get(draft.linkId) as { sequence: number };
      this.retireWakes(draft.linkId, sequence - WATCHER_WAKE_RETENTION);
      this.database.prepare(`
        INSERT INTO watcher_wakes (
          id, link_id, watched_turn_id, sequence, trigger, state,
          events_covered, items_truncated, items_omitted, digest_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, 'dispatching', ?, ?, ?, ?, ?)
      `).run(
        draft.id, draft.linkId, draft.watchedTurnId, sequence, draft.trigger,
        boundedCount(draft.eventsCovered), boundedCount(draft.itemsTruncated),
        boundedCount(draft.itemsOmitted), Math.min(65_536, boundedCount(draft.digestBytes)), at,
      );
      this.database.prepare(`
        UPDATE watcher_links
        SET wakes_this_turn = wakes_this_turn
              + CASE WHEN ? = 1 AND (cursor_turn_id IS NULL OR cursor_turn_id IS ?) THEN 1 ELSE 0 END,
            wakes_total = wakes_total + 1,
            last_wake_at = ?, feed_revision = feed_revision + 1, updated_at = ?
        WHERE id = ?
      `).run(draft.consumesAllowance === false ? 0 : 1, draft.watchedTurnId, at, at, draft.linkId);
      return this.getWake(draft.id);
    })();
  }

  attachWakeTurn(wakeId: string, turnId: string, now: string): boolean {
    const at = requireTimestamp(now, "Watcher check start time");
    return this.database.transaction(() => {
      const changed = this.database.prepare(`
        UPDATE watcher_wakes SET watcher_turn_id = ?, state = 'running'
        WHERE id = ? AND state = 'dispatching' AND watcher_turn_id IS NULL
          AND EXISTS (
            SELECT 1 FROM agent_turns AS turn
            JOIN watcher_links AS link ON link.id = watcher_wakes.link_id
            WHERE turn.id = ? AND turn.conversation_id = link.watcher_conversation_id
          )
      `).run(turnId, wakeId, turnId).changes === 1;
      if (changed) this.bumpFeedForWake(wakeId, at);
      return changed;
    })();
  }

  settleWake(
    wakeId: string,
    outcome: WatcherWakeOutcome,
    guard: WatcherGuardResult | null,
    findingPreview: string | null,
    now: string,
    commandsDeclined = 0,
  ): WatcherWakeRecord | null {
    const at = requireTimestamp(now, "Watcher check settlement time");
    return this.database.transaction(() => {
      const changed = this.database.prepare(`
        UPDATE watcher_wakes
        SET state = 'settled', outcome = ?, guard_state = ?, guard_paths_json = ?,
            finding_preview = ?, settled_at = ?, commands_declined = ?
        WHERE id = ? AND state IN ${ACTIVE_WAKE_STATES_SQL}
      `).run(
        outcome,
        guard?.state ?? null,
        boundedGuardPaths(guard?.paths ?? []),
        findingPreview === null ? null : truncateUtf8Bytes(findingPreview, MAX_WATCHER_FINDING_BYTES),
        at,
        boundedCount(commandsDeclined),
        wakeId,
      ).changes;
      if (changed !== 1) return null;
      if (outcome === "finding") {
        this.database.prepare(`
          UPDATE watcher_links SET findings_total = findings_total + 1
          WHERE id = (SELECT link_id FROM watcher_wakes WHERE id = ?)
        `).run(wakeId);
      }
      this.bumpFeedForWake(wakeId, at);
      return this.getWake(wakeId);
    })();
  }

  getWake(wakeId: string): WatcherWakeRecord | null {
    const row = this.database.prepare("SELECT * FROM watcher_wakes WHERE id = ?")
      .get(wakeId) as WatcherWakeRow | undefined;
    return row ? watcherWakeFromRow(row) : null;
  }

  wakeForTurn(turnId: string): WatcherWakeRecord | null {
    const row = this.database.prepare("SELECT * FROM watcher_wakes WHERE watcher_turn_id = ?")
      .get(turnId) as WatcherWakeRow | undefined;
    return row ? watcherWakeFromRow(row) : null;
  }

  feed(linkId: string, beforeSequence?: number, limit = MAX_WATCHER_FEED_PAGE): WatcherFeedPage | null {
    const link = this.database.prepare("SELECT feed_revision FROM watcher_links WHERE id = ?")
      .get(linkId) as { feed_revision: number } | undefined;
    if (!link) return null;
    const pageSize = Math.min(MAX_WATCHER_FEED_PAGE, Math.max(1, Math.trunc(limit) || 1));
    const rows = this.database.prepare(`
      SELECT * FROM watcher_wakes
      WHERE link_id = ? AND sequence < ?
      ORDER BY sequence DESC LIMIT ?
    `).all(linkId, beforeSequence ?? Number.MAX_SAFE_INTEGER, pageSize + 1) as WatcherWakeRow[];
    const items = rows.slice(0, pageSize).map((row) => watcherFeedItem(watcherWakeFromRow(row)));
    return {
      linkId,
      feedRevision: link.feed_revision,
      items,
      next: rows.length > pageSize ? { beforeSequence: items.at(-1)!.sequence } : null,
    };
  }

  setDelivery(wakeId: string, update: WatcherDeliveryUpdate, now: string): WatcherWakeRecord | null {
    const at = requireTimestamp(now, "Watcher delivery time");
    if ((update.mode === null) !== (update.state === "dismissed")) return null;
    return this.database.transaction(() => {
      const wake = this.getWake(wakeId);
      if (!wake || wake.state !== "settled" || wake.outcome !== "finding" || wake.finding === null) return null;
      if (!DELIVERY_TRANSITIONS[wake.delivery?.state ?? "none"].includes(update.state)) return null;
      this.database.prepare(`
        UPDATE watcher_wakes
        SET delivery_mode = ?, delivery_state = ?, delivery_detail = ?,
            delivery_id = COALESCE(?, delivery_id),
            delivered_message_id = COALESCE(?, delivered_message_id),
            queued_message_id = COALESCE(?, queued_message_id),
            delivered_at = ?
        WHERE id = ?
      `).run(
        update.mode,
        update.state,
        update.detail ? clipCodeUnits(update.detail, MAX_WATCHER_DELIVERY_DETAIL_CHARS) : null,
        update.deliveryId ?? null,
        update.deliveredMessageId ?? null,
        update.queuedMessageId ?? null,
        at,
        wakeId,
      );
      this.bumpFeedForWake(wakeId, at);
      return this.getWake(wakeId);
    })();
  }

  markResolved(wakeId: string, bySequence: number, now: string): WatcherWakeRecord | null {
    const at = requireTimestamp(now, "Watcher resolution time");
    if (!Number.isSafeInteger(bySequence)) return null;
    return this.database.transaction(() => {
      const changed = this.database.prepare(`
        UPDATE watcher_wakes SET resolved_by_sequence = ?
        WHERE id = ? AND state = 'settled' AND outcome = 'finding'
          AND resolved_by_sequence IS NULL AND sequence < ?
          AND EXISTS (
            SELECT 1 FROM watcher_wakes AS later
            WHERE later.link_id = watcher_wakes.link_id AND later.sequence = ?
          )
      `).run(bySequence, wakeId, bySequence, bySequence).changes;
      if (changed !== 1) return null;
      this.bumpFeedForWake(wakeId, at);
      return this.getWake(wakeId);
    })();
  }

  rewindCursor(linkId: string, turnId: string, now: string): WatcherLinkRecord | null {
    const at = requireTimestamp(now, "Watcher review time");
    const changed = this.database.prepare(`
      UPDATE watcher_links
      SET cursor_activity_at = NULL, cursor_activity_id = NULL, cursor_message_at = NULL,
          cursor_message_id = NULL, pending_running_ids_json = '[]', updated_at = ?
      WHERE id = ? AND cursor_turn_id = ? AND status <> 'detached'
    `).run(at, linkId, turnId).changes;
    return changed === 1 ? this.get(linkId) : null;
  }

  findingsForTurn(linkId: string, watchedTurnId: string, limit: number): WatcherWakeRecord[] {
    const bounded = Math.min(MAX_WATCHER_FEED_PAGE, Math.max(0, Math.trunc(limit) || 0));
    if (bounded === 0) return [];
    const rows = cachedStatement(this.database, `
      SELECT * FROM watcher_wakes
      WHERE link_id = ? AND watched_turn_id = ? AND state = 'settled' AND outcome = 'finding'
      ORDER BY sequence DESC LIMIT ?
    `).all(linkId, watchedTurnId, bounded) as WatcherWakeRow[];
    return rows.reverse().map(watcherWakeFromRow);
  }

  findingsBySequence(linkId: string, sequences: readonly number[]): WatcherWakeRecord[] {
    const bounded = [...new Set(sequences.filter((sequence) => Number.isSafeInteger(sequence) && sequence > 0))]
      .slice(0, MAX_WATCHER_FEED_PAGE);
    if (bounded.length === 0) return [];
    const rows = cachedStatement(this.database, `
      SELECT * FROM watcher_wakes
      WHERE link_id = ? AND sequence IN (SELECT value FROM json_each(?))
        AND state = 'settled' AND outcome = 'finding'
      ORDER BY sequence ASC
    `).all(linkId, JSON.stringify(bounded)) as WatcherWakeRow[];
    return rows.map(watcherWakeFromRow);
  }

  usageTotals(linkId: string): WatcherUsage {
    const rows = cachedStatement(this.database, `
      SELECT ${USAGE_DASHBOARD_TURN_COLUMNS}
      FROM agent_turns
      WHERE conversation_id = (SELECT watcher_conversation_id FROM watcher_links WHERE id = ?)
        AND status IN ${TERMINAL_TURN_STATUSES_SQL}
        AND association = 'authoritative'
        AND origin IS NULL
    `).all(linkId) as UsageDashboardTurnRow[];
    let totalTokens: number | null = null;
    for (const row of rows) {
      const measured = measuredProcessedTokens(usageDashboardTurnFromRow(row));
      if (measured === null) continue;
      totalTokens = Math.min(Number.MAX_SAFE_INTEGER, (totalTokens ?? 0) + measured);
    }
    return { totalTokens };
  }

  policyForConversation(conversationId: string): { linkId: string; status: WatcherStatus } | null {
    const row = cachedStatement(this.database, "SELECT id, status FROM watcher_links WHERE watcher_conversation_id = ?")
      .get(conversationId) as { id: string; status: WatcherStatus } | undefined;
    return row ? { linkId: row.id, status: row.status } : null;
  }

  assertRunConfigurationAllowed(conversationId: string, configuration: WatcherRunConfiguration): void {
    const policy = this.policyForConversation(conversationId);
    if (!policy || policy.status === "detached") return;
    if (configuration.interactionMode !== "plan" || configuration.accessMode !== "supervised") {
      throw new WatcherPolicyError("A watcher stays read-only: plan mode with supervised access.");
    }
    if (!watcherHarnessAllowed(configuration.harnessId)) {
      throw new WatcherPolicyError("This agent can't run as a watcher.");
    }
  }

  assertWakeTurnAllowed(conversationId: string, wakeId?: string): void {
    if (wakeId === undefined) return;
    const allowed = this.database.prepare(`
      SELECT 1 FROM watcher_wakes AS wake
      JOIN watcher_links AS link ON link.id = wake.link_id
      WHERE wake.id = ? AND link.watcher_conversation_id = ?
        AND link.status <> 'detached'
        AND wake.state = 'dispatching' AND wake.watcher_turn_id IS NULL
      LIMIT 1
    `).get(wakeId, conversationId);
    if (!allowed) throw new WatcherPolicyError("This watcher check is no longer waiting to start.");
  }

  recoverInterruptedWakes(now: string): { wakes: number; links: number } {
    const at = requireTimestamp(now, "Watcher recovery time");
    return this.database.transaction(() => {
      const recovered = this.database.prepare(`
        UPDATE watcher_wakes
        SET state = 'settled', outcome = 'failed', settled_at = ?
        WHERE state IN ${ACTIVE_WAKE_STATES_SQL}
          AND NOT EXISTS (
            SELECT 1 FROM agent_turns AS turn
            WHERE turn.id = watcher_wakes.watcher_turn_id
              AND turn.status NOT IN ${TERMINAL_TURN_STATUSES_SQL}
          )
        RETURNING link_id
      `).all(at) as { link_id: string }[];
      const touched = [...new Set(recovered.map(({ link_id }) => link_id))];
      if (touched.length > 0) {
        this.database.prepare(`
          UPDATE watcher_links SET feed_revision = feed_revision + 1, updated_at = ?
          WHERE id IN (SELECT value FROM json_each(?))
        `).run(at, JSON.stringify(touched));
      }
      const links = this.database.prepare(`
        UPDATE watcher_links SET status = 'watching', updated_at = ?
        WHERE status = 'waking' AND NOT EXISTS (
          SELECT 1 FROM watcher_wakes AS wake
          WHERE wake.link_id = watcher_links.id AND wake.state IN ${ACTIVE_WAKE_STATES_SQL}
        )
      `).run(at).changes;
      return { wakes: recovered.length, links };
    })();
  }

  private retireWakes(linkId: string, through: number): void {
    if (through < 1) return;
    const retired = this.database.prepare(`
      SELECT wake.id, turn.id AS turn_id, turn.conversation_id
      FROM watcher_wakes AS wake
      JOIN watcher_links AS link ON link.id = wake.link_id
      LEFT JOIN agent_turns AS turn ON turn.id = wake.watcher_turn_id
        AND turn.conversation_id = link.watcher_conversation_id
      WHERE wake.link_id = ? AND wake.sequence <= ?
        AND (turn.id IS NULL OR (
          turn.status IN ${TERMINAL_TURN_STATUSES_SQL}
          AND NOT EXISTS (SELECT 1 FROM provider_run_ownership AS owner WHERE owner.turn_id = turn.id)
        ))
      ORDER BY wake.sequence ASC LIMIT ?
    `).all(linkId, through, MAX_RETIRED_WAKES_PER_CHECK) as { id: string; turn_id: string | null; conversation_id: string | null }[];
    for (const wake of retired) {
      this.database.prepare("DELETE FROM watcher_wakes WHERE id = ?").run(wake.id);
      if (wake.turn_id === null) continue;
      for (const table of ["messages", "activities", "agent_reasonings", "agent_plans"]) {
        this.database.prepare(`DELETE FROM ${table} WHERE conversation_id = ? AND turn_id = ?`).run(wake.conversation_id, wake.turn_id);
      }
    }
  }

  private require(linkId: string): WatcherLinkRecord {
    const link = this.get(linkId);
    if (!link) throw new Error("The watcher link was not recorded.");
    return link;
  }

  private bumpFeedForWake(wakeId: string, at: string): void {
    this.database.prepare(`
      UPDATE watcher_links SET feed_revision = feed_revision + 1, updated_at = ?
      WHERE id = (SELECT link_id FROM watcher_wakes WHERE id = ?)
    `).run(at, wakeId);
  }
}
