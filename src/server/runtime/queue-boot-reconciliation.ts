import { createHash } from "node:crypto";

import type { ModelSelection } from "../../shared/contracts";
import type { RuntimeStore } from "../database";
import {
  QUEUE_ITEM_PROJECTION,
  QUEUE_STATE_PROJECTION,
  queueUnreadFollowUpCommandId,
  type QueueCreatedBy,
  type QueueCreationSource,
  type QueueItemAttribution,
  type QueueItemProjection,
} from "../../shared/orchestration-queue";
import type { QueueContentMismatch } from "../orchestration-v2/event-store";
import { UNKNOWN_FOLLOW_UP_DELIVERY } from "./turns/turn-follow-up-coordinator";

export const QUEUE_TEXT_LOST_DETAIL = "This queued message's text was lost; remove it";
export const MAX_UNATTENDED_RESENDS = 3;
const UNATTENDED_RESEND_COMMAND_PREFIX = "queue-unattended-resend:";
const UNATTENDED_RESEND_MARK_COMMAND_PREFIX = "queue-unattended-resend-mark:";
const MAX_PARENT_STOP_DEPTH = 3;

export interface QueueBootReconciliationReport {
  adoptedLegacy: number;
  reconciledDelivered: string[];
  blockedTextLost: string[];
  blockedUnconfirmedSteers: string[];
  releasedDispatching: string[];
  requeuedUndelivered: string[];
  requeuedUnreadSteers: string[];
  heldConversations: string[];
  resendsScheduled: string[];
  resendsExhausted: string[];
}

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type OrchestrationDatabase = RuntimeStore["orchestration"]["effects"]["connection"];

/**
 * True when any durable provider-turn observation exists for `runId` (native
 * boundary entity/event, attempt `nativeTurnId`, terminal assistant message, or
 * a terminal run without `delivery = 'not-delivered'`). Never decides by status alone.
 */
export function hasProviderTurnObservation(
  db: OrchestrationDatabase,
  conversationId: string,
  runId: string,
): boolean {
  const observed = db.prepare(`
    SELECT 1 WHERE
      EXISTS (
        SELECT 1 FROM orchestration_v2_entities
        WHERE kind = 'native-boundary' AND thread_id = ?
          AND json_extract(payload_json, '$.runId') = ?
      )
      OR EXISTS (
        SELECT 1 FROM orchestration_v2_entities
        WHERE kind = 'attempt' AND thread_id = ?
          AND json_extract(payload_json, '$.runId') = ?
          AND json_extract(payload_json, '$.nativeTurnId') IS NOT NULL
      )
      OR EXISTS (
        SELECT 1 FROM orchestration_v2_events
        WHERE thread_id = ? AND type = 'provider.native-boundary'
          AND json_extract(payload_json, '$.runId') = ?
      )
      OR EXISTS (
        SELECT 1 FROM orchestration_v2_entities
        WHERE kind = 'run' AND thread_id = ? AND id = ?
          AND (
            json_extract(payload_json, '$.terminalMessageId') IS NOT NULL
            OR (
              json_extract(payload_json, '$.status') IN ('completed', 'failed', 'cancelled', 'interrupted')
              AND COALESCE(json_extract(payload_json, '$.delivery'), '') <> 'not-delivered'
            )
          )
      )
  `).get(
    conversationId, runId,
    conversationId, runId,
    conversationId, runId,
    conversationId, runId,
  );
  return observed !== undefined;
}

/**
 * Counts cumulative durable process losses for an item across boots from
 * `orchestration_v2_events` (requeued undelivered runs, `runtime-lost` claim
 * releases, and unattended boot-resend releases for waiting items).
 */
export function countDurableProcessLosses(
  db: OrchestrationDatabase,
  conversationId: string,
  itemId: string,
  userMessageId: string | null,
): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM orchestration_v2_events
    WHERE thread_id = ?
      AND (
        (type = 'queue.item-requeued' AND (
          json_extract(payload_json, '$.itemId') = ?
          OR (? IS NOT NULL AND json_extract(payload_json, '$.userMessageId') = ?)
        ))
        OR (type = 'queue.item-released'
          AND json_extract(payload_json, '$.itemId') = ?
          AND json_extract(payload_json, '$.reason') = 'runtime-lost')
        OR (type = 'queue.items-released'
          AND command_id LIKE ?
          AND EXISTS (
            SELECT 1 FROM json_each(payload_json, '$.itemIds')
            WHERE value = ?
          ))
      )
  `).get(
    conversationId,
    itemId,
    userMessageId,
    userMessageId,
    itemId,
    `${UNATTENDED_RESEND_COMMAND_PREFIX}%`,
    itemId,
  ) as { count: number } | undefined;
  return row?.count ?? 0;
}

function hasRecordedStopOnThread(
  store: RuntimeStore,
  db: OrchestrationDatabase,
  conversationId: string,
  runId: string | null,
  itemId: string | null,
  since: string,
): boolean {
  const runControl = store.orchestration.runControl;
  if (runId !== null) {
    const target = runControl.target(runId);
    if (target && (target.interruptRequested || runControl.attemptInterrupt(target.attemptId) !== null)) {
      return true;
    }
    const runInterruptEvent = db.prepare(`
      SELECT 1 FROM orchestration_v2_events
      WHERE type IN ('run-control.interrupt-recorded', 'attempt.interrupt-requested')
        AND json_extract(payload_json, '$.runId') = ?
      LIMIT 1
    `).get(runId);
    if (runInterruptEvent !== undefined) return true;
  }
  if (itemId !== null) {
    const itemStopHold = db.prepare(`
      SELECT 1 FROM orchestration_v2_events
      WHERE thread_id = ? AND type = 'queue.items-held'
        AND json_extract(payload_json, '$.cause') = 'H1-stop'
        AND EXISTS (
          SELECT 1 FROM json_each(payload_json, '$.itemIds')
          WHERE value = ?
        )
      LIMIT 1
    `).get(conversationId, itemId);
    if (itemStopHold !== undefined) return true;
  }
  const threadStopEvent = db.prepare(`
    SELECT 1 FROM orchestration_v2_events
    WHERE thread_id = ? AND created_at >= ?
      AND (
        type = 'run-control.interrupt-recorded'
        OR type = 'attempt.interrupt-requested'
        OR (type = 'queue.items-held' AND json_extract(payload_json, '$.cause') = 'H1-stop')
      )
    LIMIT 1
  `).get(conversationId, since);
  if (threadStopEvent !== undefined) return true;
  const stopReceipt = db.prepare(`
    SELECT 1 FROM orchestration_v2_receipts
    WHERE thread_id = ? AND command_type = 'agent.stop' AND created_at >= ?
    LIMIT 1
  `).get(conversationId, since);
  return stopReceipt !== undefined;
}

function hasRecordedStopForRunOrParent(
  store: RuntimeStore,
  db: OrchestrationDatabase,
  conversationId: string,
  runId: string | null,
  itemId: string | null,
  since: string,
): boolean {
  if (hasRecordedStopOnThread(store, db, conversationId, runId, itemId, since)) return true;

  let currentId = conversationId;
  const visited = new Set<string>([conversationId]);
  for (let depth = 0; depth < MAX_PARENT_STOP_DEPTH; depth += 1) {
    const parent = db.prepare(`
      SELECT source_conversation_id, source_run_id, created_at
      FROM agent_managed_conversations
      WHERE child_conversation_id = ?
    `).get(currentId) as {
      source_conversation_id: string | null;
      source_run_id: string;
      created_at: string;
    } | undefined;
    if (!parent) break;

    const parentRun = db.prepare(`
      SELECT json_extract(payload_json, '$.requestedAt') AS requested_at
      FROM orchestration_v2_entities
      WHERE kind = 'run' AND id = ?
      LIMIT 1
    `).get(parent.source_run_id) as { requested_at: string | null } | undefined;
    const parentSince = typeof parentRun?.requested_at === "string" && parentRun.requested_at.length > 0
      ? parentRun.requested_at
      : parent.created_at;

    if (parent.source_conversation_id) {
      if (hasRecordedStopOnThread(
        store,
        db,
        parent.source_conversation_id,
        parent.source_run_id,
        null,
        parentSince,
      )) return true;
      if (visited.has(parent.source_conversation_id)) break;
      visited.add(parent.source_conversation_id);
      currentId = parent.source_conversation_id;
    } else {
      const target = store.orchestration.runControl.target(parent.source_run_id);
      if (target && (target.interruptRequested || store.orchestration.runControl.attemptInterrupt(target.attemptId) !== null)) {
        return true;
      }
      const parentInterrupt = db.prepare(`
        SELECT 1 FROM orchestration_v2_events
        WHERE type IN ('run-control.interrupt-recorded', 'attempt.interrupt-requested')
          AND json_extract(payload_json, '$.runId') = ?
        LIMIT 1
      `).get(parent.source_run_id);
      if (parentInterrupt !== undefined) return true;
      break;
    }
  }
  return false;
}

function isUnattendedMessageCreationSource(source: string): boolean {
  return source === "mcp" || source === "scheduled" || source === "server";
}

function isScheduledTaskAttribution(attribution: QueueItemAttribution | undefined): boolean {
  return attribution !== undefined && "scheduledTask" in attribution;
}

function isUnattendedQueueItem(
  store: RuntimeStore,
  db: OrchestrationDatabase,
  conversationId: string,
  item: QueueItemProjection,
): boolean {
  if (item.kind !== "message") return false;
  if (item.attribution !== undefined && !isScheduledTaskAttribution(item.attribution)) return false;
  if (item.steerFollowUpOfRunId !== undefined) return false;
  if (!isUnattendedMessageCreationSource(item.creationSource)) return false;

  const row = db.prepare(`
    SELECT watcher_note_json, delegated_completion_json
    FROM queued_messages
    WHERE id = ? AND conversation_id = ?
  `).get(item.id, conversationId) as {
    watcher_note_json: string | null;
    delegated_completion_json: string | null;
  } | undefined;
  if (row && (row.watcher_note_json !== null || row.delegated_completion_json !== null)) {
    return false;
  }
  if (item.userMessageId !== null) {
    try {
      const message = store.message(item.userMessageId);
      if (message.watcherNote || message.delegatedCompletion) return false;
    } catch {
      // Message absent; fall back to queue item metadata above.
    }
  }
  return true;
}

interface TurnCreationProvenance {
  createdBy: QueueCreatedBy;
  creationSource: QueueCreationSource;
  deviceId?: string;
  attribution?: QueueItemAttribution;
  freshContext?: true;
  followsThreadSelection?: true;
  modelSelection?: ModelSelection | null;
  reusableDeliveredItemId: string | null;
  isUnattended: boolean;
  isExcluded: boolean;
}

function resolveTurnCreationProvenance(
  store: RuntimeStore,
  db: OrchestrationDatabase,
  conversationId: string,
  turn: { id: string; runId: string; userMessageId: string },
  message: { id: string; privateConnectDeviceId?: string | null; watcherNote?: unknown; delegatedCompletion?: unknown },
): TurnCreationProvenance {
  if (message.watcherNote || message.delegatedCompletion) {
    return { createdBy: "system", creationSource: "server", reusableDeliveredItemId: null, isUnattended: false, isExcluded: true };
  }

  const queue = store.orchestration.queue;
  const runRow = db.prepare(`
    SELECT json_extract(payload_json, '$.queueItemId') AS queue_item_id
    FROM orchestration_v2_entities
    WHERE kind = 'run' AND thread_id = ? AND id = ?
    LIMIT 1
  `).get(conversationId, turn.runId) as { queue_item_id: string | null } | undefined;
  const runQueueItemId = typeof runRow?.queue_item_id === "string" && runRow.queue_item_id.length > 0
    ? runRow.queue_item_id
    : null;

  let sourceItem: QueueItemProjection | null = runQueueItemId ? queue.getItem(runQueueItemId) : null;
  if (!sourceItem) {
    const priorItemRow = db.prepare(`
      SELECT id FROM orchestration_v2_entities
      WHERE kind = ? AND thread_id = ? AND json_extract(payload_json, '$.userMessageId') = ?
      ORDER BY revision DESC
      LIMIT 1
    `).get(QUEUE_ITEM_PROJECTION, conversationId, message.id) as { id: string } | undefined;
    if (priorItemRow) sourceItem = queue.getItem(priorItemRow.id);
  }

  const reusableDeliveredItemId = sourceItem?.state === "delivered" ? sourceItem.id : null;

  if (sourceItem) {
    if (sourceItem.kind !== "message" || (sourceItem.attribution !== undefined && !isScheduledTaskAttribution(sourceItem.attribution))) {
      return { createdBy: "system", creationSource: "server", reusableDeliveredItemId: null, isUnattended: false, isExcluded: true };
    }
    return {
      createdBy: sourceItem.createdBy,
      creationSource: sourceItem.creationSource,
      ...(sourceItem.deviceId !== undefined ? { deviceId: sourceItem.deviceId } : {}),
      ...(sourceItem.attribution !== undefined ? { attribution: sourceItem.attribution } : {}),
      ...(sourceItem.freshContext !== undefined ? { freshContext: sourceItem.freshContext } : {}),
      ...(sourceItem.followsThreadSelection !== undefined ? { followsThreadSelection: sourceItem.followsThreadSelection } : {}),
      ...(sourceItem.modelSelection !== undefined ? { modelSelection: sourceItem.modelSelection } : {}),
      reusableDeliveredItemId,
      isUnattended: isUnattendedMessageCreationSource(sourceItem.creationSource),
      isExcluded: false,
    };
  }

  const legacyRow = db.prepare(`
    SELECT kind, created_by, creation_source, device_id, watcher_note_json, delegated_completion_json
    FROM queued_messages
    WHERE conversation_id = ? AND (turn_id = ? OR run_id = ?)
    ORDER BY sequence DESC
    LIMIT 1
  `).get(conversationId, turn.id, turn.runId) as {
    kind: string;
    created_by: QueueCreatedBy;
    creation_source: QueueCreationSource;
    device_id: string | null;
    watcher_note_json: string | null;
    delegated_completion_json: string | null;
  } | undefined;

  if (legacyRow) {
    if (legacyRow.kind !== "message" || legacyRow.watcher_note_json !== null || legacyRow.delegated_completion_json !== null) {
      return { createdBy: "system", creationSource: "server", reusableDeliveredItemId: null, isUnattended: false, isExcluded: true };
    }
    return {
      createdBy: legacyRow.created_by,
      creationSource: legacyRow.creation_source,
      ...(legacyRow.device_id ? { deviceId: legacyRow.device_id } : {}),
      reusableDeliveredItemId,
      isUnattended: isUnattendedMessageCreationSource(legacyRow.creation_source),
      isExcluded: false,
    };
  }

  const isScheduledPlan = db.prepare(`
    SELECT 1 WHERE
      EXISTS (SELECT 1 FROM usage_limit_resume_plans WHERE conversation_id = ? AND turn_id = ?)
      OR EXISTS (SELECT 1 FROM restart_continuation_plans WHERE conversation_id = ? AND turn_id = ?)
  `).get(conversationId, turn.id, conversationId, turn.id) !== undefined;
  if (isScheduledPlan) {
    return {
      createdBy: "system",
      creationSource: "server",
      reusableDeliveredItemId,
      isUnattended: true,
      isExcluded: false,
    };
  }

  const acceptedEvent = db.prepare(`
    SELECT command_id FROM orchestration_v2_events
    WHERE thread_id = ? AND type = 'run.accepted'
      AND json_extract(payload_json, '$.run.id') = ?
    ORDER BY sequence DESC
    LIMIT 1
  `).get(conversationId, turn.runId) as { command_id: string } | undefined;
  const commandId = acceptedEvent?.command_id ?? "";
  if (
    commandId.startsWith("limit-reset:")
    || commandId.startsWith("restart-continuation:")
    || commandId.startsWith("scheduled:")
  ) {
    return {
      createdBy: "system",
      creationSource: "server",
      reusableDeliveredItemId,
      isUnattended: true,
      isExcluded: false,
    };
  }
  if (commandId.startsWith("agent-") || commandId.startsWith("mcp:")) {
    return {
      createdBy: "agent",
      creationSource: "mcp",
      reusableDeliveredItemId,
      isUnattended: true,
      isExcluded: false,
    };
  }

  return {
    createdBy: "user",
    creationSource: message.privateConnectDeviceId ? "mobile" : "web",
    ...(message.privateConnectDeviceId ? { deviceId: message.privateConnectDeviceId } : {}),
    reusableDeliveredItemId,
    isUnattended: false,
    isExcluded: false,
  };
}

/**
 * Per-chat durable boot reconciliation for the V2 queue (Phase 5 §2.9).
 * Runs inside each chat's orchestration lane before any command or auto-dispatch:
 * 1. Adopts legacy `queued_messages` rows into V2 queue events.
 * 2. Reconciles active V2 items whose `queued_messages` row was already durably marked `accepted` with a persisted follow-up message (settling open `provider.steer` effects as `accepted` and delivering the V2 item instead of marking it `text-lost` or requeuing).
 * 3. Blocks items whose `queued_messages` row is missing or mismatched (`text-lost`).
 * 4. Retires orphaned `dispatching` steers / blocks items whose `provider.steer` effect retired `runtime-lost`.
 * 5. Releases any `dispatching -> waiting` claims (`runtime-lost`) and clears stale `steerWhenReadyRunId`.
 * 6. Requeues interrupted runs that never reached a provider turn (`!hasProviderTurnObservation`, `delivery = 'not-delivered'`) at the front, preserving `creationSource` and releasing unattended MCP/scheduled prompts when `< MAX_UNATTENDED_RESENDS` and no Stop was recorded on the run or its delegating parent.
 * 7. Requeues accepted unread steers (`listUnreadAcceptedSteers`) at their N2 position, held.
 * 8. Applies the H5 restart hold to remaining unheld items, while allowing eligible never-started unattended prompts (within the cumulative `MAX_UNATTENDED_RESENDS` cap and without a recorded Stop) to resend automatically.
 */
export async function reconcileQueueOnBoot(store: RuntimeStore): Promise<QueueBootReconciliationReport> {
  const report: QueueBootReconciliationReport = {
    adoptedLegacy: 0,
    reconciledDelivered: [],
    blockedTextLost: [],
    blockedUnconfirmedSteers: [],
    releasedDispatching: [],
    requeuedUndelivered: [],
    requeuedUnreadSteers: [],
    heldConversations: [],
    resendsScheduled: [],
    resendsExhausted: [],
  };

  const adoption = store.orchestration.queue.adoptLegacyRows();
  report.adoptedLegacy = adoption.adopted.length;

  const db = store.orchestration.effects.connection;
  const verification = store.orchestration.events.verify({ readable: true });
  const mismatchesByThread = new Map<string, QueueContentMismatch[]>();
  for (const mismatch of verification.queueContentMismatches) {
    const list = mismatchesByThread.get(mismatch.threadId) ?? [];
    list.push(mismatch);
    mismatchesByThread.set(mismatch.threadId, list);
  }

  const candidateIds = new Set<string>();
  for (const { conversation_id } of db.prepare(
    "SELECT DISTINCT conversation_id FROM queued_messages WHERE state IN ('waiting','dispatching','blocked')",
  ).all() as Array<{ conversation_id: string }>) {
    candidateIds.add(conversation_id);
  }
  for (const { thread_id } of db.prepare(
    `SELECT DISTINCT thread_id FROM orchestration_v2_entities
     WHERE kind IN (?, ?) AND json_array_length(COALESCE(json_extract(payload_json, '$.activeItemIds'), '[]')) > 0`,
  ).all(QUEUE_STATE_PROJECTION, QUEUE_ITEM_PROJECTION) as Array<{ thread_id: string }>) {
    candidateIds.add(thread_id);
  }
  for (const threadId of mismatchesByThread.keys()) candidateIds.add(threadId);
  for (const { conversation_id } of db.prepare(
    "SELECT DISTINCT conversation_id FROM agent_turns WHERE status = 'interrupted'",
  ).all() as Array<{ conversation_id: string }>) {
    candidateIds.add(conversation_id);
  }
  for (const { thread_id } of db.prepare(
    "SELECT DISTINCT thread_id FROM orchestration_v2_effects WHERE kind = 'provider.steer' AND state = 'retired' AND failure_code = 'runtime-lost'",
  ).all() as Array<{ thread_id: string }>) {
    candidateIds.add(thread_id);
  }

  for (const conversationId of candidateIds) {
    await store.orchestration.lanes.run(conversationId, () => {
      reconcileConversationQueueOnBoot(store, conversationId, mismatchesByThread.get(conversationId) ?? [], report);
    });
  }

  return report;
}

function reconcileConversationQueueOnBoot(
  store: RuntimeStore,
  conversationId: string,
  mismatches: readonly QueueContentMismatch[],
  report: QueueBootReconciliationReport,
): void {
  try {
    store.conversation(conversationId);
  } catch {
    return;
  }

  const db = store.orchestration.effects.connection;
  const queue = store.orchestration.queue;
  const runControl = store.orchestration.runControl;

  // 0. Reconcile active V2 items whose compatibility row was already durably
  // accepted in `transcript-repository.ts` before a crash (prevents false
  // `text-lost` classification, orphaned open steer effects, or duplicate sends).
  for (const item of queue.listActive(conversationId)) {
    if (item.state !== "dispatching" && item.state !== "waiting") continue;
    const row = db.prepare(`
      SELECT state, turn_id, user_message_id, delivery_mode
      FROM queued_messages
      WHERE id = ? AND conversation_id = ?
    `).get(item.id, conversationId) as {
      state: string;
      turn_id: string | null;
      user_message_id: string | null;
      delivery_mode: string | null;
    } | undefined;
    if (!row || row.state !== "accepted" || !row.turn_id || !row.user_message_id) continue;
    let message;
    let turn;
    try {
      message = store.message(row.user_message_id);
      turn = store.agentTurn(row.turn_id);
    } catch {
      continue;
    }
    if (message.conversationId !== conversationId || turn.conversationId !== conversationId) continue;

    const matchingSteerEffects = db.prepare(`
      SELECT id FROM orchestration_v2_effects
      WHERE thread_id = ? AND kind = 'provider.steer'
        AND json_extract(payload_json, '$.queuedMessageId') = ?
      ORDER BY sequence DESC
    `).all(conversationId, item.id) as Array<{ id: string }>;
    let steerEffectId: string | undefined;
    let steerAttemptId: string | undefined;
    for (const effect of matchingSteerEffects) {
      const steer = runControl.steer(effect.id);
      if (!steer) continue;
      if (steer.state === "dispatching") {
        runControl.settleSteer(effect.id, "accepted", {
          messageId: message.id,
          queuedMessageId: item.id,
        });
        steerEffectId ??= effect.id;
        steerAttemptId ??= steer.attemptId;
      } else if (steer.state === "settled" && steer.outcome === "accepted") {
        steerEffectId ??= effect.id;
        steerAttemptId ??= steer.attemptId;
      }
    }

    const mode = row.delivery_mode === "run" || row.delivery_mode === "steer" || row.delivery_mode === "after-stop"
      ? row.delivery_mode
      : "steer";
    const attemptId = store.orchestration.currentAttemptId(turn.runId) ?? steerAttemptId ?? turn.runId;
    queue.deliver({
      conversationId,
      itemId: item.id,
      delivery: {
        mode,
        runId: turn.runId,
        attemptId,
        turnId: turn.id,
        messageId: message.id,
        ...(steerEffectId ? { steerEffectId } : {}),
        deliveredAt: message.createdAt,
      },
    });
    report.reconciledDelivered.push(item.id);
  }

  // 1. Block items whose text row is missing or disagrees with V2 contentRef.
  for (const mismatch of mismatches) {
    const item = queue.getItem(mismatch.itemId);
    if (!item || (item.state !== "waiting" && item.state !== "dispatching" && item.state !== "blocked")) continue;
    if (item.state === "blocked" && item.blockedReason === "text-lost") continue;
    queue.block({
      conversationId,
      itemId: item.id,
      blockedReason: "text-lost",
      detail: QUEUE_TEXT_LOST_DETAIL,
    });
    report.blockedTextLost.push(item.id);
  }

  // 2. Steer effects retired as `runtime-lost`: block their queued item as unconfirmed and settle orphaned steer state.
  const retiredSteers = db.prepare(`
    SELECT id, payload_json FROM orchestration_v2_effects
    WHERE thread_id = ? AND kind = 'provider.steer' AND state = 'retired' AND failure_code = 'runtime-lost'
  `).all(conversationId) as Array<{ id: string; payload_json: string }>;
  for (const effect of retiredSteers) {
    let queuedMessageId: string | undefined;
    try {
      const payload = JSON.parse(effect.payload_json) as { queuedMessageId?: unknown };
      if (typeof payload.queuedMessageId === "string") queuedMessageId = payload.queuedMessageId;
    } catch {
      queuedMessageId = undefined;
    }
    if (queuedMessageId) {
      const item = queue.getItem(queuedMessageId);
      if (item && (item.state === "waiting" || item.state === "dispatching")) {
        queue.block({
          conversationId,
          itemId: item.id,
          blockedReason: "steer-unconfirmed",
          detail: UNKNOWN_FOLLOW_UP_DELIVERY,
        });
        report.blockedUnconfirmedSteers.push(item.id);
      }
    }
    const steer = runControl.steer(effect.id);
    if (steer && steer.state === "dispatching") {
      runControl.settleSteer(effect.id, "unconfirmed", { queuedMessageId: queuedMessageId ?? null });
    }
  }

  // 3. Release any still-dispatching claims (`runtime-lost`) and clear stale `steerWhenReadyRunId`.
  const releasedDispatchingIds = new Set<string>();
  for (const item of queue.listActive(conversationId)) {
    if (item.state === "dispatching") {
      queue.releaseClaim({
        conversationId,
        itemId: item.id,
        reason: "runtime-lost",
        detail: "The runtime restarted before dispatch finished.",
      });
      releasedDispatchingIds.add(item.id);
      report.releasedDispatching.push(item.id);
    }
  }
  db.prepare("UPDATE queued_messages SET state = 'waiting', error = NULL WHERE conversation_id = ? AND state = 'dispatching'")
    .run(conversationId);
  db.prepare("UPDATE queued_messages SET steer_when_ready_run_id = NULL WHERE conversation_id = ? AND steer_when_ready_run_id IS NOT NULL")
    .run(conversationId);

  // 4. Requeue interrupted runs that never observed a provider turn (`!hasProviderTurnObservation`, `delivery = 'not-delivered'`).
  const autoResentThisBoot = new Set<string>();
  const latestTurn = store.latestAgentTurnForConversation(conversationId);
  if (latestTurn && latestTurn.status === "interrupted" && !queue.getSupersededTurn(latestTurn.id)) {
    const rolledBack = db.prepare(`
      SELECT 1 FROM orchestration_v2_entities
      WHERE kind = 'rolled-back-turn' AND thread_id = ? AND id = ?
      LIMIT 1
    `).get(conversationId, latestTurn.id) !== undefined;
    const hasRunRecord = db.prepare(`
      SELECT 1 FROM orchestration_v2_entities
      WHERE kind = 'run' AND thread_id = ? AND id = ?
        AND json_extract(payload_json, '$.delivery') = 'not-delivered'
      LIMIT 1
    `).get(conversationId, latestTurn.runId) !== undefined;
    const undeliveredEligible = !rolledBack
      && hasRunRecord
      && !hasProviderTurnObservation(db, conversationId, latestTurn.runId);
    const alreadyQueued = queue.listActive(conversationId).some((item) => item.userMessageId === latestTurn.userMessageId);
    if (undeliveredEligible && !alreadyQueued) {
      try {
        const message = store.message(latestTurn.userMessageId);
        if (message.conversationId === conversationId && message.role === "user" && message.turnId === latestTurn.id) {
          const provenance = resolveTurnCreationProvenance(store, db, conversationId, latestTurn, message);
          if (!provenance.isExcluded) {
            const itemId = provenance.reusableDeliveredItemId
              ?? deterministicUuid(`requeue-undelivered:${latestTurn.runId}`);
            const stopBlocksResend = provenance.isUnattended && hasRecordedStopForRunOrParent(
              store,
              db,
              conversationId,
              latestTurn.runId,
              itemId,
              latestTurn.requestedAt,
            );
            let queueHeld = true;
            let bootAutoResend = false;
            let totalProcessLosses: number | undefined;
            if (provenance.isUnattended && !stopBlocksResend) {
              totalProcessLosses = countDurableProcessLosses(db, conversationId, itemId, message.id) + 1;
              if (totalProcessLosses < MAX_UNATTENDED_RESENDS) {
                queueHeld = false;
                bootAutoResend = true;
                autoResentThisBoot.add(itemId);
                report.resendsScheduled.push(itemId);
              } else {
                queueHeld = true;
                report.resendsExhausted.push(itemId);
              }
            }
            queue.requeueUndelivered({
              conversationId,
              itemId,
              fromRunId: latestTurn.runId,
              fromTurnId: latestTurn.id,
              userMessageId: message.id,
              content: message.content,
              attachments: message.attachments,
              createdBy: provenance.createdBy,
              creationSource: provenance.creationSource,
              ...(provenance.deviceId !== undefined ? { deviceId: provenance.deviceId } : {}),
              ...(provenance.attribution !== undefined ? { attribution: provenance.attribution } : {}),
              ...(provenance.freshContext !== undefined ? { freshContext: provenance.freshContext } : {}),
              ...(provenance.followsThreadSelection !== undefined ? { followsThreadSelection: provenance.followsThreadSelection } : {}),
              modelSelection: provenance.followsThreadSelection
                ? null
                : (provenance.modelSelection !== undefined ? provenance.modelSelection : latestTurn.modelSelection),
              requestedAt: latestTurn.requestedAt,
              queueHeld,
              ...(bootAutoResend ? { bootAutoResend: true } : {}),
              placement: "front",
              ...(totalProcessLosses !== undefined ? {
                commandType: bootAutoResend ? "queue.unattended-boot-resend" : "queue.requeue",
                source: {
                  actorId: "runtime",
                  commandId: `queue-requeue:${latestTurn.runId}:${itemId}`,
                  command: {
                    type: bootAutoResend ? "queue.unattended-boot-resend" : "queue.requeue",
                    conversationId,
                    itemId,
                    fromRunId: latestTurn.runId,
                    fromTurnId: latestTurn.id,
                    userMessageId: message.id,
                    processLossCount: totalProcessLosses,
                  },
                },
              } : {}),
            });
            report.requeuedUndelivered.push(itemId);
          }
        }
      } catch {
        // Message no longer present; skip.
      }
    }
  }

  // 5. Requeue accepted unread steers from interrupted runs at their N2 position, held.
  const interruptedTurns = db.prepare(`
    SELECT id, run_id FROM agent_turns
    WHERE conversation_id = ? AND status = 'interrupted'
    ORDER BY requested_at DESC, id DESC
    LIMIT 10
  `).all(conversationId) as Array<{ id: string; run_id: string }>;
  for (const turn of interruptedTurns) {
    if (store.orchestration.events.projection("rolled-back-turn", turn.id) !== null) continue;
    const unreadSteers = runControl.listUnreadAcceptedSteers(turn.run_id);
    for (const steer of unreadSteers) {
      if (!steer.messageId) continue;
      if (queue.listActive(conversationId).some((item) => item.userMessageId === steer.messageId)) continue;
      let message;
      try {
        message = store.message(steer.messageId);
      } catch {
        continue;
      }
      if (message.conversationId !== conversationId || message.role !== "user" || message.turnId !== turn.id) continue;
      const itemId = deterministicUuid(`unread-steer:${turn.id}:${message.id}`);
      const afterItemIds = queue.listActive(conversationId)
        .filter((item) => item.requestedAt <= steer.requestedAt)
        .map(({ id }) => id);
      const commandId = queueUnreadFollowUpCommandId(turn.id, message.id);
      queue.enqueue({
        conversationId,
        itemId,
        content: message.content.slice(0, 20_000),
        attachments: message.attachments,
        kind: "message",
        userMessageId: message.id,
        createdBy: message.watcherNote || message.delegatedCompletion ? "system" : "user",
        creationSource: message.privateConnectDeviceId ? "mobile" : (message.watcherNote || message.delegatedCompletion ? "server" : "web"),
        ...(message.privateConnectDeviceId ? { deviceId: message.privateConnectDeviceId } : {}),
        steerFollowUpOfRunId: turn.run_id,
        placement: { afterItemIds },
        queueHeld: true,
        requestedAt: steer.requestedAt,
        origin: "requeue",
        source: {
          actorId: "runtime",
          commandId,
          command: { type: "queue.requeue-unread-steer", conversationId, turnId: turn.id, messageId: message.id },
        },
        commandType: "queue.requeue-unread-steer",
      });
      report.requeuedUnreadSteers.push(itemId);
    }
  }

  // 6. H5 restart hold: hold unheld active items at boot, while allowing eligible
  // never-started unattended prompts (`mcp` / `scheduled`, excluding delegated deliveries
  // and watcher notes) to resend up to `MAX_UNATTENDED_RESENDS` when no Stop was recorded.
  const active = queue.listActive(conversationId);
  const toHold: string[] = [];
  const toHoldStopped: string[] = [];
  for (const item of active) {
    if (autoResentThisBoot.has(item.id)) continue;
    const stopBlocksResend = hasRecordedStopForRunOrParent(
      store,
      db,
      conversationId,
      item.requeuedFromRunId ?? null,
      item.id,
      item.requestedAt,
    );
    if (item.queueHeld) {
      if (stopBlocksResend && item.bootAutoResend === true) {
        toHoldStopped.push(item.id);
      }
      continue;
    }
    const eligibleUnattended = item.state === "waiting"
      && isUnattendedQueueItem(store, db, conversationId, item)
      && (item.requeuedFromRunId === undefined
        || !hasProviderTurnObservation(db, conversationId, item.requeuedFromRunId))
      && !stopBlocksResend;
    if (!eligibleUnattended) {
      if (stopBlocksResend) toHoldStopped.push(item.id);
      else toHold.push(item.id);
      continue;
    }
    const existingLosses = countDurableProcessLosses(db, conversationId, item.id, item.userMessageId);
    const totalProcessLosses = releasedDispatchingIds.has(item.id)
      ? existingLosses
      : existingLosses + 1;
    if (totalProcessLosses < MAX_UNATTENDED_RESENDS) {
      if (!releasedDispatchingIds.has(item.id)) {
        queue.hold({
          conversationId,
          cause: "H5-restart",
          itemIds: [item.id],
        });
        queue.release({
          conversationId,
          cause: "R4-preparation-retry",
          itemIds: [item.id],
          bootAutoResend: true,
          commandType: "queue.unattended-boot-resend",
          source: {
            actorId: "runtime",
            commandId: `${UNATTENDED_RESEND_COMMAND_PREFIX}${item.id}:${totalProcessLosses}`,
            command: {
              type: "queue.unattended-boot-resend",
              conversationId,
              itemId: item.id,
              processLossCount: totalProcessLosses,
            },
          },
        });
      } else if (item.bootAutoResend !== true) {
        queue.release({
          conversationId,
          cause: "R4-preparation-retry",
          itemIds: [item.id],
          bootAutoResend: true,
          commandType: "queue.unattended-boot-resend",
          source: {
            actorId: "runtime",
            commandId: `${UNATTENDED_RESEND_MARK_COMMAND_PREFIX}${item.id}:${totalProcessLosses}`,
            command: {
              type: "queue.unattended-boot-resend",
              conversationId,
              itemId: item.id,
              processLossCount: totalProcessLosses,
            },
          },
        });
      }
      report.resendsScheduled.push(item.id);
    } else {
      toHold.push(item.id);
      report.resendsExhausted.push(item.id);
    }
  }
  if (toHoldStopped.length > 0) {
    queue.hold({
      conversationId,
      cause: "H1-stop",
      itemIds: toHoldStopped,
    });
  }
  if (toHold.length > 0) {
    queue.hold({
      conversationId,
      cause: "H5-restart",
      itemIds: toHold,
    });
  }
  if (toHoldStopped.length > 0 || toHold.length > 0) {
    report.heldConversations.push(conversationId);
  }
}
