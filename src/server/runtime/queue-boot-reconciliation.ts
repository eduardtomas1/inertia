import { createHash } from "node:crypto";

import type { RuntimeStore } from "../database";
import {
  QUEUE_ITEM_PROJECTION,
  QUEUE_STATE_PROJECTION,
  queueUnreadFollowUpCommandId,
} from "../../shared/orchestration-queue";
import type { QueueContentMismatch } from "../orchestration-v2/event-store";
import { UNKNOWN_FOLLOW_UP_DELIVERY } from "./turns/turn-follow-up-coordinator";

export const QUEUE_TEXT_LOST_DETAIL = "This queued message's text was lost; remove it";

export interface QueueBootReconciliationReport {
  adoptedLegacy: number;
  blockedTextLost: string[];
  blockedUnconfirmedSteers: string[];
  releasedDispatching: string[];
  requeuedUndelivered: string[];
  requeuedUnreadSteers: string[];
  heldConversations: string[];
}

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Per-chat durable boot reconciliation for the V2 queue (Phase 5 §2.9).
 * Runs inside each chat's orchestration lane before any command or auto-dispatch:
 * 1. Adopts legacy `queued_messages` rows into V2 queue events.
 * 2. Blocks items whose `queued_messages` row is missing or mismatched (`text-lost`).
 * 3. Retires orphaned `dispatching` steers / blocks items whose `provider.steer` effect retired `runtime-lost`.
 * 4. Releases any `dispatching -> waiting` claims (`runtime-lost`) and clears stale `steerWhenReadyRunId`.
 * 5. Requeues interrupted runs that never reached a provider turn (`delivery = 'not-delivered'`, zero native boundaries) at the front, held.
 * 6. Requeues accepted unread steers (`listUnreadAcceptedSteers`) at their N2 position, held.
 * 7. Applies the H5 restart hold to all active unheld items (`H5-restart`).
 */
export async function reconcileQueueOnBoot(store: RuntimeStore): Promise<QueueBootReconciliationReport> {
  const report: QueueBootReconciliationReport = {
    adoptedLegacy: 0,
    blockedTextLost: [],
    blockedUnconfirmedSteers: [],
    releasedDispatching: [],
    requeuedUndelivered: [],
    requeuedUnreadSteers: [],
    heldConversations: [],
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
  for (const item of queue.listActive(conversationId)) {
    if (item.state === "dispatching") {
      queue.releaseClaim({
        conversationId,
        itemId: item.id,
        reason: "runtime-lost",
        detail: "The runtime restarted before dispatch finished.",
      });
      report.releasedDispatching.push(item.id);
    }
  }
  db.prepare("UPDATE queued_messages SET state = 'waiting', error = NULL WHERE conversation_id = ? AND state = 'dispatching'")
    .run(conversationId);
  db.prepare("UPDATE queued_messages SET steer_when_ready_run_id = NULL WHERE conversation_id = ? AND steer_when_ready_run_id IS NOT NULL")
    .run(conversationId);

  // 4. Requeue interrupted runs that never observed a provider turn (`delivery = 'not-delivered'`, zero native boundaries).
  const latestTurn = store.latestAgentTurnForConversation(conversationId);
  if (latestTurn && latestTurn.status === "interrupted" && !queue.getSupersededTurn(latestTurn.id)) {
    const undeliveredEligible = db.prepare(`
      SELECT 1 FROM agent_turns AS turn
      JOIN orchestration_v2_entities AS run ON run.kind = 'run' AND run.thread_id = turn.conversation_id AND run.id = turn.run_id
      WHERE turn.id = ? AND turn.conversation_id = ?
        AND json_extract(run.payload_json, '$.delivery') = 'not-delivered'
        AND NOT EXISTS (SELECT 1 FROM orchestration_v2_entities AS rb WHERE rb.kind = 'rolled-back-turn' AND rb.thread_id = turn.conversation_id AND rb.id = turn.id)
        AND NOT EXISTS (SELECT 1 FROM orchestration_v2_entities AS b WHERE b.kind = 'native-boundary' AND b.thread_id = turn.conversation_id AND json_extract(b.payload_json, '$.runId') = turn.run_id)
        AND NOT EXISTS (SELECT 1 FROM orchestration_v2_entities AS a WHERE a.kind = 'attempt' AND a.thread_id = turn.conversation_id AND json_extract(a.payload_json, '$.runId') = turn.run_id AND json_extract(a.payload_json, '$.nativeTurnId') IS NOT NULL)
    `).get(latestTurn.id, conversationId);
    const alreadyQueued = queue.listActive(conversationId).some((item) => item.userMessageId === latestTurn.userMessageId);
    if (undeliveredEligible && !alreadyQueued) {
      try {
        const message = store.message(latestTurn.userMessageId);
        if (message.conversationId === conversationId && message.role === "user" && message.turnId === latestTurn.id
          && !message.watcherNote && !message.delegatedCompletion) {
          const itemId = deterministicUuid(`requeue-undelivered:${latestTurn.runId}`);
          queue.requeueUndelivered({
            conversationId,
            itemId,
            fromRunId: latestTurn.runId,
            fromTurnId: latestTurn.id,
            userMessageId: message.id,
            content: message.content,
            attachments: message.attachments,
            modelSelection: latestTurn.modelSelection,
            requestedAt: latestTurn.requestedAt,
            queueHeld: true,
            placement: "front",
          });
          report.requeuedUndelivered.push(itemId);
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

  // 6. H5 restart hold: hold every unheld active item at boot (no automatic dispatch after restart).
  const active = queue.listActive(conversationId);
  const unheld = active.filter((item) => !item.queueHeld);
  if (unheld.length > 0) {
    queue.hold({
      conversationId,
      cause: "H5-restart",
      itemIds: unheld.map(({ id }) => id),
    });
    report.heldConversations.push(conversationId);
  }
}
