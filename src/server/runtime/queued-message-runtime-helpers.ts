import type { AgentTurn, ChatAttachment, Conversation, ModelSelection, ProviderId } from "../../shared/contracts";
import { supportsNativeResume } from "../../shared/follow-up-steer";
import { providerIdForHarness } from "../../shared/model-routing";
import {
  MAX_QUEUED_USER_AND_AGENT_ITEMS,
  MAX_QUEUED_WATCHER_NOTES,
  type QueueHoldReason,
  type QueueItemProjection,
  type QueuePendingSendIntent,
} from "../../shared/orchestration-queue";
import type { MessageQueueResult, QueuedMessage } from "../../shared/queued-messages";
import type { RuntimeStore } from "../database";
import { providerInstanceId } from "../orchestration-v2/provider-instance";
import { queuedRouteIdentity } from "../persistence/queued-message-repository";
import { resetQuota } from "../usage/limit-reset-policy";
import type { NativeUsageAccount } from "../usage/subscription-io";
import { hasIncompleteWorktreeSetup } from "../workspace-path-authority";

export const RESUME_WORKTREE_SETUP_ERROR = "Retry worktree setup or choose a workspace before resuming the queue.";
export const RESUME_USAGE_LIMIT_ERROR = "Continue the limited thread before resuming its queue.";
export const PROMPTED_RESUME_TEXT = "Continue where you left off.";
export const NATIVE_RESUME_TEXT = "Continue from where you stopped.";
export const PRIVATE_CONNECT_ATTACHMENT_SEND_ERROR = "Queued messages with attachments cannot be sent from a paired device.";

export type UsageLimitHoldCheck = (
  conversationId: string,
  providerId: ProviderId,
  model?: string,
) => boolean | undefined;

/** Resolves the effective ModelSelection for a queued item (per-item override vs thread selection). */
export function resolveEffectiveQueuedSelection(
  entry: Pick<QueuedMessage, "modelSelection" | "followsThreadSelection" | "delegatedCompletion" | "watcherNote">,
  conversation: Pick<Conversation, "modelSelection">,
): ModelSelection {
  if (!entry.followsThreadSelection && !entry.delegatedCompletion && !entry.watcherNote && entry.modelSelection) {
    return entry.modelSelection;
  }
  return conversation.modelSelection;
}

/** Returns the effective selection of the next active queue item, falling back to the conversation's selection. */
export function nextQueuedSelectionForConversation(
  store: RuntimeStore,
  conversationId: string,
): ModelSelection | null {
  let conversation: Conversation;
  try {
    conversation = store.conversation(conversationId);
  } catch {
    return null;
  }
  const entries = listQueueEntries(store, conversationId);
  const next = entries.find((entry) => entry.state === "waiting" && !entry.queueHeld) ?? entries[0];
  return next ? resolveEffectiveQueuedSelection(next, conversation) : conversation.modelSelection;
}

export function latestTurnForProvider(
  store: RuntimeStore,
  conversationId: string,
  providerId: ProviderId,
): AgentTurn | null {
  const turns = store.agentTurnsForConversation(conversationId);
  let latest: AgentTurn | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const turn of turns) {
    if (turn.providerId !== providerId) continue;
    const requestedAtMs = Date.parse(turn.requestedAt);
    const comparable = Number.isFinite(requestedAtMs) ? requestedAtMs : Number.NEGATIVE_INFINITY;
    if (latest === null || comparable >= latestMs) {
      latest = turn;
      latestMs = comparable;
    }
  }
  return latest;
}

/**
 * Computes whether a provider usage limit currently holds automatic queue dispatch
 * for the target selection's provider (Phase 5 N8). Computed, never stored:
 * - Evaluates the latest turn for the target provider specifically so another
 *   provider running in between neither falsely holds a different provider's items
 *   nor clears an active reset window for the limited provider.
 * - An unknown/null or expired `resetsAt` lifts the hold.
 * - A newer turn on that provider lifts the hold automatically.
 */
export function usageLimitHoldsQueue(
  store: RuntimeStore,
  conversationId: string,
  targetSelection?: ModelSelection | null,
  nowMs: number = Date.now(),
): boolean {
  let conversation: Conversation;
  try {
    conversation = store.conversation(conversationId);
  } catch {
    return false;
  }
  const effectiveSelection = targetSelection ?? conversation.modelSelection;
  const targetProviderId = providerIdForHarness(effectiveSelection.harnessId) ?? conversation.providerId;
  const latest = latestTurnForProvider(store, conversationId, targetProviderId);
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
  if (conversation.providerId === targetProviderId && conversation.snoozedUntil) {
    const snoozeMs = Date.parse(conversation.snoozedUntil);
    if (Number.isFinite(snoozeMs) && snoozeMs > nowMs) return true;
  }
  return false;
}

/**
 * Checks provider-scoped usage-limit hold, preferring the live `LimitResetScheduler`
 * callback (which inspects cached provider account reset windows even without an
 * armed plan or snooze) before falling back to the store-only check.
 */
export function isUsageLimitHeldForSelection(
  store: RuntimeStore,
  conversationId: string,
  targetSelection?: ModelSelection | null,
  usageLimitHold?: UsageLimitHoldCheck,
  nowMs: number = Date.now(),
): boolean {
  if (usageLimitHold) {
    try {
      const conversation = store.conversation(conversationId);
      const effectiveSelection = targetSelection ?? conversation.modelSelection;
      const targetProviderId = providerIdForHarness(effectiveSelection.harnessId) ?? conversation.providerId;
      const held = usageLimitHold(conversationId, targetProviderId, effectiveSelection.modelId);
      if (held !== undefined) return held;
    } catch {
      return false;
    }
  }
  return usageLimitHoldsQueue(store, conversationId, targetSelection, nowMs);
}

/**
 * S10: Builds a `UsageLimitHoldCheck` backed by `UsageLimitsService.cachedNativeAccount`
 * so a known future provider account reset holds that provider's queued items even when
 * no reset plan is armed and no snooze is set (matching `LimitResetScheduler.usageLimitHoldsQueue`).
 */
export function createCachedAccountUsageLimitHold(
  store: RuntimeStore,
  cachedAccount: (providerId: ProviderId, model?: string, cwd?: string) => NativeUsageAccount | null,
): UsageLimitHoldCheck {
  return (conversationId, providerId, model) => {
    let conversation: Conversation;
    try {
      conversation = store.conversation(conversationId);
    } catch {
      return false;
    }
    const latest = latestTurnForProvider(store, conversationId, providerId);
    if (!latest || latest.status !== "failed") return false;
    if (!store.limitResets.usageLimited(latest.id)) return false;
    const now = Date.now();
    const effectiveModel = model ?? latest.model;
    const cwd = store.conversationPath(conversationId);
    const plan = store.limitResets.get(conversationId);
    const activePlanResetsAt = plan
      && plan.failedTurnId === latest.id
      && (plan.state === "waiting" || plan.state === "dispatching")
      ? plan.resetsAt
      : null;
    const account = cachedAccount(providerId, effectiveModel, cwd);
    if (account && account.providerId === providerId) {
      const quota = resetQuota(account, effectiveModel, now, latest.modelSelection.alias);
      if (quota.kind === "available") return false;
      if (quota.kind === "exhausted") {
        const resetsAtMs = Date.parse(quota.resetsAt);
        return Number.isFinite(resetsAtMs) && resetsAtMs > now;
      }
      return activePlanResetsAt !== null && Date.parse(activePlanResetsAt) > now;
    }
    if (activePlanResetsAt !== null && Date.parse(activePlanResetsAt) > now) return true;
    return conversation.providerId === providerId
      && typeof conversation.snoozedUntil === "string"
      && Date.parse(conversation.snoozedUntil) > now;
  };
}

export type ResumeContinuationPlan =
  | { kind: "native"; content: string; modelSelection: ModelSelection; sessionId: string; turnId: string; runId: string }
  | { kind: "prompted"; content: string; modelSelection: ModelSelection; sessionId: null; turnId: string; runId: string }
  | { kind: "queue" }
  | { kind: "noop" };

function hasAssistantMessageForTurn(
  store: RuntimeStore,
  conversationId: string,
  turnId: string,
): boolean {
  const row = store.orchestration.effects.connection.prepare(
    "SELECT 1 FROM messages WHERE conversation_id = ? AND turn_id = ? AND role = 'assistant' LIMIT 1",
  ).get(conversationId, turnId);
  return row !== undefined;
}

/**
 * N7: decides whether `message.queue.resume` continues the latest stopped/interrupted/failed
 * run natively first (pinned to `latest.modelSelection`), falls back to prompted continuation
 * when appropriate, dispatches the next waiting queued item, or no-ops for a non-native-resume
 * harness whose stopped turn already ran when the queue is empty.
 */
export function resolveResumeContinuation(
  store: RuntimeStore,
  conversationId: string,
): ResumeContinuationPlan {
  let conversation: Conversation;
  try {
    conversation = store.conversation(conversationId);
  } catch {
    return { kind: "queue" };
  }
  const latest = store.latestAgentTurnForConversation(conversationId);
  if (
    !latest
    || (latest.status !== "cancelled" && latest.status !== "interrupted" && latest.status !== "failed")
  ) {
    return { kind: "queue" };
  }
  const v2Active = store.orchestration.queue.listActive(conversationId);
  // If the stopped/interrupted run's undelivered prompt was requeued, dispatching that item continues it.
  if (v2Active.some((item) => item.requeuedFromTurnId === latest.id)) {
    return { kind: "queue" };
  }
  const nativeSupported = supportsNativeResume(latest.harnessId);
  const sessionId = latest.providerSessionAfter
    ?? latest.providerSessionBefore
    ?? (conversation.providerId === latest.providerId ? conversation.providerSessionId : null);
  const hasResumableSession = sessionId !== null
    && !store.orchestration.backings.sessionRetired({
      threadId: conversationId,
      providerId: latest.providerId,
      identity: latest.continuationIdentity,
      nativeSessionId: sessionId,
    });
  const missedImages = hasMissedRunImages(store, latest)
    || store.orchestration.missedRunImages({
      threadId: conversationId,
      providerInstanceId: providerInstanceId(latest.providerId, latest.continuationIdentity),
    }).length > 0;
  if (nativeSupported && hasResumableSession && !missedImages) {
    return { kind: "native", content: NATIVE_RESUME_TEXT, modelSelection: latest.modelSelection, sessionId, turnId: latest.id, runId: latest.runId };
  }
  if (nativeSupported && missedImages) {
    return { kind: "prompted", content: PROMPTED_RESUME_TEXT, modelSelection: latest.modelSelection, sessionId: null, turnId: latest.id, runId: latest.runId };
  }
  const hasWaiting = listQueueEntries(store, conversationId).some((entry) => entry.state === "waiting" && !entry.queueHeld);
  if (!nativeSupported) {
    const reachedProvider = latest.terminalAssistantMessageId !== null
      || store.turnLedgerRepository.turnHasProviderActivity(conversationId, latest.id, latest.harnessId)
      || hasAssistantMessageForTurn(store, conversationId, latest.id);
    if (!reachedProvider) {
      return { kind: "prompted", content: PROMPTED_RESUME_TEXT, modelSelection: latest.modelSelection, sessionId: null, turnId: latest.id, runId: latest.runId };
    }
    return hasWaiting ? { kind: "queue" } : { kind: "noop" };
  }
  if (hasWaiting) return { kind: "queue" };
  return { kind: "prompted", content: PROMPTED_RESUME_TEXT, modelSelection: latest.modelSelection, sessionId: null, turnId: latest.id, runId: latest.runId };
}

/** Returns true once a run has already been accepted/started after the stored resume intent. */
export function isResumeIntentFulfilled(
  store: RuntimeStore,
  conversationId: string,
  intent: QueuePendingSendIntent,
): boolean {
  const db = store.orchestration.effects.connection;
  const intentEvent = db.prepare(`
    SELECT sequence, created_at FROM orchestration_v2_events
    WHERE thread_id = ? AND type = 'queue.send-requested'
      AND json_extract(payload_json, '$.requestId') = ?
    ORDER BY sequence DESC LIMIT 1
  `).get(conversationId, intent.requestId) as { sequence: number; created_at: string } | undefined;
  if (intentEvent) {
    const newerV2Run = db.prepare(`
      SELECT 1 FROM orchestration_v2_events
      WHERE thread_id = ? AND type = 'run.accepted' AND sequence > ?
      LIMIT 1
    `).get(conversationId, intentEvent.sequence);
    return newerV2Run !== undefined;
  }
  const latestTurn = store.latestAgentTurnForConversation(conversationId);
  if (!latestTurn) return false;
  const intentMs = Date.parse(intent.requestedAt);
  const turnMs = Date.parse(latestTurn.requestedAt);
  return Number.isFinite(intentMs) && Number.isFinite(turnMs) && turnMs > intentMs;
}

/** R4: preparation retry releases held items only while no newer executed run exists after the hold. */
export function canReleaseWorktreeSetupRetry(
  store: RuntimeStore,
  conversationId: string,
): boolean {
  const db = store.orchestration.effects.connection;
  if (hasIncompleteWorktreeSetup(db, conversationId)) return false;
  const holdEvent = db.prepare(`
    SELECT sequence, created_at FROM orchestration_v2_events
    WHERE thread_id = ?
      AND (
        type = 'queue.items-held'
        OR (type = 'queue.item-enqueued' AND json_extract(payload_json, '$.queueHeld') = 1)
      )
    ORDER BY sequence DESC LIMIT 1
  `).get(conversationId) as { sequence: number; created_at: string } | undefined;
  if (!holdEvent) return true;
  const newerV2Run = db.prepare(`
    SELECT 1 FROM orchestration_v2_events
    WHERE thread_id = ? AND type = 'run.accepted' AND sequence > ?
    LIMIT 1
  `).get(conversationId, holdEvent.sequence);
  if (newerV2Run !== undefined) return false;
  const latestTurn = store.latestAgentTurnForConversation(conversationId);
  if (latestTurn) {
    const turnV2 = db.prepare(`
      SELECT sequence FROM orchestration_v2_events
      WHERE thread_id = ? AND type = 'run.accepted'
        AND json_extract(payload_json, '$.run.id') = ?
      ORDER BY sequence DESC LIMIT 1
    `).get(conversationId, latestTurn.runId) as { sequence: number } | undefined;
    if (turnV2) return turnV2.sequence <= holdEvent.sequence;
    const holdMs = Date.parse(holdEvent.created_at);
    const turnMs = Date.parse(latestTurn.requestedAt);
    if (Number.isFinite(holdMs) && Number.isFinite(turnMs) && turnMs > holdMs) return false;
  }
  return true;
}

/** Returns true if an R4-preparation-retry release occurred after any executed run. */
export function hasWorktreeRetryReleaseAuthority(
  store: RuntimeStore,
  conversationId: string,
  latestTurn: AgentTurn | null,
): boolean {
  const db = store.orchestration.effects.connection;
  const releaseEvent = db.prepare(`
    SELECT sequence, created_at FROM orchestration_v2_events
    WHERE thread_id = ? AND type = 'queue.items-released'
      AND json_extract(payload_json, '$.cause') = 'R4-preparation-retry'
    ORDER BY sequence DESC LIMIT 1
  `).get(conversationId) as { sequence: number; created_at: string } | undefined;
  if (!releaseEvent) return false;
  const newerRun = db.prepare(`
    SELECT 1 FROM orchestration_v2_events
    WHERE thread_id = ? AND type = 'run.accepted' AND sequence > ?
    LIMIT 1
  `).get(conversationId, releaseEvent.sequence);
  if (newerRun !== undefined) return false;
  if (latestTurn) {
    const turnV2 = db.prepare(`
      SELECT sequence FROM orchestration_v2_events
      WHERE thread_id = ? AND type = 'run.accepted'
        AND json_extract(payload_json, '$.run.id') = ?
      ORDER BY sequence DESC LIMIT 1
    `).get(conversationId, latestTurn.runId) as { sequence: number } | undefined;
    if (turnV2) return turnV2.sequence <= releaseEvent.sequence;
    const releaseMs = Date.parse(releaseEvent.created_at);
    const turnMs = Date.parse(latestTurn.requestedAt);
    if (Number.isFinite(releaseMs) && Number.isFinite(turnMs) && turnMs > releaseMs) return false;
  }
  return true;
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
  usageLimitHold?: UsageLimitHoldCheck,
): QueueHoldReason | null {
  const db = store.orchestration.effects.connection;
  if (hasIncompleteWorktreeSetup(db, conversationId)) return "workspace-setup";
  const nextSelection = nextQueuedSelectionForConversation(store, conversationId);
  if (isUsageLimitHeldForSelection(store, conversationId, nextSelection, usageLimitHold, nowMs)) return "usage-limit";
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
    usageLimitHold?: UsageLimitHoldCheck;
  },
): MessageQueueResult {
  const entries = listQueueEntries(store, conversationId);
  const v2Active = store.orchestration.queue.listActive(conversationId);
  const revision = store.orchestration.queue.revision(conversationId);
  const holdReason = computeQueueHoldReason(store, conversationId, v2Active, options.nowMs, options.usageLimitHold);
  const held = v2Active.some((item) => item.queueHeld) || holdReason !== null;

  let canResume = false;
  let resumePrompted = false;
  try {
    const conversation = store.conversation(conversationId);
    if (conversation.archivedAt === null && !options.isActive && !options.hasPendingInteraction) {
      const latest = store.latestAgentTurnForConversation(conversationId);
      const nativeResume = supportsNativeResume((latest?.modelSelection ?? conversation.modelSelection).harnessId);
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

/**
 * S12: Rebinds setup-held waiting items whose routeIdentity was captured pre-setup
 * (`worktreePath === null`) to the newly created worktree checkout before R4 release.
 */
export function rebindPreSetupWorktreeItems(
  store: RuntimeStore,
  conversationId: string,
): boolean {
  let conversation: Conversation;
  try {
    conversation = store.conversation(conversationId);
  } catch {
    return false;
  }
  if (conversation.worktreePath === null) return false;
  const queue = store.orchestration.queue;
  const db = store.orchestration.effects.connection;
  let rebound = false;
  for (const item of queue.listActive(conversationId)) {
    if (!item.queueHeld || item.state !== "waiting" || item.kind !== "message") continue;
    const rawRoute = item.routeIdentity ?? (db.prepare(
      "SELECT route_identity FROM queued_messages WHERE id = ? AND conversation_id = ?",
    ).get(item.id, conversationId) as { route_identity: string } | undefined)?.route_identity;
    if (!rawRoute) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawRoute);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed) || parsed.length < 8) continue;
    if (parsed[0] !== conversation.projectId || parsed[1] !== null) continue;
    const contentRow = queue.getContent(conversationId, item.id);
    const nextRouteIdentity = (!item.followsThreadSelection && item.modelSelection)
      ? routeIdentityForSelection(conversation, item.modelSelection)
      : queuedRouteIdentity(conversation);
    queue.edit({
      conversationId,
      itemId: item.id,
      expectedRevision: item.contentRef.editRevision,
      content: contentRow?.content ?? "",
      routeIdentity: nextRouteIdentity,
      source: {
        actorId: "runtime",
        commandId: `queue-rebind-worktree:${item.id}:${conversation.worktreePath}`,
        command: {
          type: "queue.rebind-worktree",
          conversationId,
          itemId: item.id,
          worktreePath: conversation.worktreePath,
        },
      },
      commandType: "queue.rebind-worktree",
    });
    rebound = true;
  }
  return rebound;
}


