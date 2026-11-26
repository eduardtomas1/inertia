import type { AgentTurn, ChatAttachment, Conversation, ModelSelection } from "../../shared/contracts";
import { supportsNativeResume } from "../../shared/follow-up-steer";
import {
  MAX_QUEUED_USER_AND_AGENT_ITEMS,
  MAX_QUEUED_WATCHER_NOTES,
  type QueueHoldReason,
  type QueueItemProjection,
} from "../../shared/orchestration-queue";
import type { MessageQueueResult, QueuedMessage } from "../../shared/queued-messages";
import type { RuntimeStore } from "../database";
import { queuedRouteIdentity } from "../persistence/queued-message-repository";
import { hasIncompleteWorktreeSetup } from "../workspace-path-authority";

export const RESUME_WORKTREE_SETUP_ERROR = "Retry worktree setup or choose a workspace before resuming the queue.";
export const RESUME_USAGE_LIMIT_ERROR = "Continue the limited thread before resuming its queue.";
export const PROMPTED_RESUME_TEXT = "Continue where you left off.";

/**
 * Computes whether a provider usage limit currently holds automatic queue dispatch
 * for this chat (Phase 5 N8). Computed, never stored:
 * - Only applies when the latest turn failed with a usage-limit record carrying a
 *   future `resetsAt`.
 * - An unknown/null `resetsAt` lifts the hold.
 * - A newer user turn lifts the hold automatically because it becomes the latest turn.
 */
export function usageLimitHoldsQueue(store: RuntimeStore, conversationId: string, nowMs: number = Date.now()): boolean {
  const latest = store.latestAgentTurnForConversation(conversationId);
  if (!latest || latest.status !== "failed") return false;
  if (!store.limitResets.usageLimited(latest.id)) return false;
  const plan = store.limitResets.get(conversationId);
  if (
    plan
    && plan.failedTurnId === latest.id
    && (plan.state === "waiting" || plan.state === "dispatching")
  ) {
    const resetMs = Date.parse(plan.resetsAt);
    if (Number.isFinite(resetMs) && resetMs > nowMs) return true;
  }
  try {
    const conversation = store.conversation(conversationId);
    if (conversation.providerId === latest.providerId && conversation.snoozedUntil) {
      const snoozeMs = Date.parse(conversation.snoozedUntil);
      if (Number.isFinite(snoozeMs) && snoozeMs > nowMs) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Computes the user-visible hold reason for a chat's queue (Phase 5 §2.2).
 * Never persisted as a separate flag: derived from live worktree setup state,
 * usage-limit reset window, latest turn outcome, and per-item `queueHeld`.
 */
export function computeQueueHoldReason(
  store: RuntimeStore,
  conversationId: string,
  activeItems: readonly QueueItemProjection[],
  nowMs: number = Date.now(),
): QueueHoldReason | null {
  const db = store.orchestration.effects.connection;
  if (hasIncompleteWorktreeSetup(db, conversationId)) return "workspace-setup";
  if (usageLimitHoldsQueue(store, conversationId, nowMs)) return "usage-limit";
  const hasHeldItem = activeItems.some((item) => item.queueHeld);
  if (!hasHeldItem) return null;
  const lastHold = db.prepare(`
    SELECT json_extract(payload_json, '$.cause') AS cause
    FROM orchestration_v2_events
    WHERE thread_id = ? AND type = 'queue.items-held'
    ORDER BY sequence DESC LIMIT 1
  `).get(conversationId) as { cause: string | null } | undefined;
  switch (lastHold?.cause) {
    case "H1-stop": return "stopped";
    case "H4-start-failure": return "provider-failed";
    case "H5-restart": return "restart";
    case "H6-busy-session": return "busy-session";
    default: break;
  }
  const latest = store.latestAgentTurnForConversation(conversationId);
  if (latest?.status === "cancelled") return "stopped";
  if (latest?.status === "interrupted") return "restart";
  if (latest?.status === "failed") return "provider-failed";
  return "stopped";
}

/**
 * Returns active queued entries in V2 delivery order, merging V2 projection fields
 * with the text/attachment row in `queued_messages`. Falls back to legacy rows if
 * any active row was inserted directly into `queued_messages` outside V2.
 */
export function listQueueEntries(store: RuntimeStore, conversationId: string): QueuedMessage[] {
  const v2Items = store.orchestration.queue.listActive(conversationId);
  const legacyById = new Map(store.queuedMessages.list(conversationId).map((entry) => [entry.id, entry]));
  const result: QueuedMessage[] = [];
  const seen = new Set<string>();
  for (const item of v2Items) {
    seen.add(item.id);
    const row = legacyById.get(item.id) ?? store.queuedMessages.get(conversationId, item.id);
    const content = row?.content ?? "";
    const attachments: ChatAttachment[] = row?.attachments ?? [];
    const state: QueuedMessage["state"] = item.state === "delivered" ? "accepted" : item.state;
    const watcherNote = item.attribution && "watcherNote" in item.attribution
      ? item.attribution.watcherNote
      : row?.watcherNote;
    const delegatedCompletion = item.attribution && "delegatedCompletion" in item.attribution
      ? item.attribution.delegatedCompletion
      : row?.delegatedCompletion;
    result.push({
      id: item.id,
      conversationId,
      content,
      attachments,
      state,
      createdAt: item.requestedAt,
      error: item.detail ?? row?.error ?? null,
      turnId: item.delivery?.turnId ?? row?.turnId ?? null,
      userMessageId: item.userMessageId,
      ...(watcherNote ? { watcherNote } : {}),
      ...(delegatedCompletion ? { delegatedCompletion } : {}),
      kind: item.kind,
      queuePosition: item.queuePosition,
      queueHeld: item.queueHeld,
      editRevision: item.contentRef.editRevision,
      editedAt: item.editedAt,
      createdBy: item.createdBy,
      creationSource: item.creationSource,
      deviceId: item.deviceId ?? null,
      steerWhenReadyRunId: item.steerWhenReadyRunId ?? row?.steerWhenReadyRunId ?? null,
      steerFollowUpOfRunId: item.steerFollowUpOfRunId ?? null,
      ...(item.modelSelection !== undefined ? { modelSelection: item.modelSelection } : {}),
      ...(item.followsThreadSelection !== undefined ? { followsThreadSelection: item.followsThreadSelection } : {}),
      dispatchOrdinal: item.dispatchOrdinal,
      runId: item.delivery?.runId ?? row?.runId ?? null,
      deliveryMode: item.delivery?.mode ?? row?.deliveryMode ?? null,
    });
  }
  for (const row of legacyById.values()) {
    if (!seen.has(row.id)) result.push(row);
  }
  return result;
}

export function buildQueueResult(
  store: RuntimeStore,
  conversationId: string,
  options: {
    id?: string;
    isActive: boolean;
    hasPendingInteraction: boolean;
    nowMs?: number;
  },
): MessageQueueResult {
  const entries = listQueueEntries(store, conversationId);
  const v2Active = store.orchestration.queue.listActive(conversationId);
  const revision = store.orchestration.queue.revision(conversationId);
  const holdReason = computeQueueHoldReason(store, conversationId, v2Active, options.nowMs);
  const held = v2Active.some((item) => item.queueHeld) || holdReason !== null;

  let canResume = false;
  let resumePrompted = false;
  try {
    const conversation = store.conversation(conversationId);
    if (conversation.archivedAt === null && !options.isActive && !options.hasPendingInteraction) {
      const latest = store.latestAgentTurnForConversation(conversationId);
      const nativeResume = supportsNativeResume(conversation.modelSelection.harnessId);
      const hasUndeliveredRequeue = v2Active.some((item) => item.requeuedFromTurnId !== undefined);
      const hasHeldItems = v2Active.some((item) => item.queueHeld);
      const latestInterruptedOrStopped = latest !== null
        && (latest.status === "cancelled" || latest.status === "interrupted" || latest.status === "failed");
      const missedRunHasImages = latestInterruptedOrStopped && latest !== null && hasMissedRunImages(store, latest);

      if (hasHeldItems) {
        canResume = true;
        resumePrompted = !nativeResume || missedRunHasImages;
      } else if (latestInterruptedOrStopped) {
        if (nativeResume) {
          canResume = true;
          resumePrompted = missedRunHasImages;
        } else if (hasUndeliveredRequeue) {
          canResume = true;
          resumePrompted = true;
        }
      }
    }
  } catch {
    canResume = false;
    resumePrompted = false;
  }

  let receipt: QueuedMessage | null = null;
  if (options.id) {
    receipt = entries.find((entry) => entry.id === options.id) ?? store.queuedMessages.get(conversationId, options.id);
  }

  return {
    kind: "message.queue",
    conversationId,
    entries,
    receipt,
    revision,
    held,
    holdReason,
    canResume,
    resumePrompted,
  };
}

function hasMissedRunImages(store: RuntimeStore, turn: AgentTurn): boolean {
  try {
    const message = store.message(turn.userMessageId);
    return message.attachments.some((attachment) => attachment.mimeType.startsWith("image/"));
  } catch {
    return false;
  }
}

/** N5: When an item names no modelSelection, inherit the queue tail's selection or the thread's current selection. */
export function resolveQueueTailSelection(
  store: RuntimeStore,
  conversation: Conversation,
  explicit?: ModelSelection | null,
): ModelSelection {
  if (explicit) return explicit;
  const active = store.orchestration.queue.listActive(conversation.id);
  for (let i = active.length - 1; i >= 0; i -= 1) {
    const item = active[i]!;
    if (item.kind === "message" && !item.followsThreadSelection && item.modelSelection) {
      return item.modelSelection;
    }
  }
  return conversation.modelSelection;
}

/** Phase 5 caps: 20 user+agent items (requeues exempt), 5 watcher notes (1 per link superseded). */
export function countUserAndAgentItems(store: RuntimeStore, conversationId: string): number {
  const v2 = store.orchestration.queue.listActive(conversationId);
  if (v2.length > 0) {
    return v2.filter((item) => item.kind === "message" && item.userMessageId === null).length;
  }
  return store.queuedMessages.list(conversationId)
    .filter((entry) => !entry.delegatedCompletion && !entry.watcherNote && entry.userMessageId === null).length;
}

export function countWatcherNotes(store: RuntimeStore, conversationId: string, excludingLinkId?: string): number {
  const v2 = store.orchestration.queue.listActive(conversationId);
  const items = v2.filter((item) => item.kind === "watcher-note" && item.state !== "delivered" && item.state !== "cancelled");
  if (excludingLinkId) {
    return items.filter((item) => !(item.attribution && "watcherNote" in item.attribution && item.attribution.watcherNote.linkId === excludingLinkId)).length;
  }
  return items.length;
}

export function isUserQueueFull(store: RuntimeStore, conversationId: string): boolean {
  return countUserAndAgentItems(store, conversationId) >= MAX_QUEUED_USER_AND_AGENT_ITEMS;
}

export function isWatcherQueueFull(store: RuntimeStore, conversationId: string, linkId?: string): boolean {
  return countWatcherNotes(store, conversationId, linkId) >= MAX_QUEUED_WATCHER_NOTES;
}

/**
 * Decision 4.3 route check: accessMode and interactionMode changes never block a queued item.
 * Automatic items (`delegatedCompletion` / `followsThreadSelection`) follow the thread's current route.
 * Workspace/project change blocks; model-route change blocks only when the item has no explicit selection
 * and its recorded route identity's provider/selection disagrees with the conversation.
 */
export function queueItemRouteMatches(
  store: RuntimeStore,
  entry: QueuedMessage,
  conversation: Conversation,
): boolean {
  if (entry.delegatedCompletion || entry.followsThreadSelection) return true;
  if (store.queuedMessages.routeMatches(entry, conversation)) return true;
  const v2 = store.orchestration.queue.getItem(entry.id);
  const rawRoute = v2?.routeIdentity ?? (store.orchestration.effects.connection.prepare(
    "SELECT route_identity FROM queued_messages WHERE id = ? AND conversation_id = ?",
  ).get(entry.id, conversation.id) as { route_identity: string } | undefined)?.route_identity;
  if (!rawRoute) return true;
  try {
    const parsed: unknown = JSON.parse(rawRoute);
    if (!Array.isArray(parsed) || parsed.length < 8) return false;
    const sameWorkspace = parsed[0] === conversation.projectId && parsed[1] === conversation.worktreePath;
    if (!sameWorkspace) return false;
    if (v2?.modelSelection || entry.modelSelection) return true;
    return parsed[2] === conversation.providerId
      && JSON.stringify(parsed[3]) === JSON.stringify(conversation.modelSelection);
  } catch {
    return false;
  }
}

export function routeIdentityForSelection(conversation: Conversation, selection: ModelSelection): string {
  return queuedRouteIdentity({
    ...conversation,
    modelSelection: selection,
    model: selection.modelId,
    reasoningEffort: selection.reasoningEffort ?? "",
  });
}
