import type WebSocket from "ws";

import type { AgentTurn, ChatAttachment, ClientCommand, ModelSelection, ServerEvent } from "../../shared/contracts";
import { chatAttachmentKind } from "../../shared/attachments";
import { providerIdForHarness } from "../../shared/model-routing";
import { MAX_QUEUED_USER_AND_AGENT_ITEMS, queueDeferredSteerCommandId } from "../../shared/orchestration-queue";
import { QUEUED_ROUTE_CHANGED_ERROR, type MessageQueueResult, type QueuedMessage } from "../../shared/queued-messages";
import type { DelegatedCompletionAttribution } from "../../shared/orchestration-delegation";
import type { WatcherNoteAttribution } from "../../shared/watcher";
import { QueuedMessageLimitError, queuedRouteIdentity, releasesQueue } from "../persistence/queued-message-repository";
import { publicRuntimeError, RuntimeRequestError } from "../runtime-errors";
import { hasIncompleteWorktreeSetup } from "../workspace-path-authority";
import { defineRuntimeCommandHandler } from "./commands/command-router";
import { createTurnInteractionCommandHandler, type TurnInteractionCommandDependencies } from "./commands/turn-interaction-commands";
import type { QueuedMessagePersistence } from "./commands/turn-interaction-types";
import { commandRejection } from "./commands/command-rejection";
import type { CommandTicket } from "../orchestration-v2/command-authority";
import { OrchestrationConflict, type CommandSource, type JsonValue } from "../orchestration-v2/types";
import {
  awaitMessageSendPreparation,
  messageSendPreparationDeadline,
} from "./commands/message-send-preparation";
import { isHeld, UPDATE_HOLD_MESSAGE } from "./update-hold";
import { CHECKOUT_RESTORE_IN_PROGRESS } from "./conversation-work-authority";
import { watcherNoteDelivery, watcherSteerContent } from "./watcher/watcher-note-instruction";
import { delegatedDelivery, delegatedSteerContent } from "./delegation/delivery-instruction";
import { takeFollowUpQueueHint } from "./queue-follow-up-hints";
import { reconcileQueueOnBoot } from "./queue-boot-reconciliation";
import { executeSteerViaEffectRuntime } from "./run-control-effect-handlers";
import { bindSteerEffectId } from "./turns/turn-follow-up-coordinator";
import {
  buildQueueResult,
  canReleaseWorktreeSetupRetry,
  hasWorktreeRetryReleaseAuthority,
  isResumeIntentFulfilled,
  isUserQueueFull,
  listQueueEntries,
  nextQueuedSelectionForConversation,
  queueItemRouteMatches,
  resolveEffectiveQueuedSelection,
  resolveQueueTailSelection,
  resolveResumeContinuation,
  RESUME_WORKTREE_SETUP_ERROR,
  routeIdentityForSelection,
  usageLimitHoldsQueue,
} from "./queued-message-runtime-helpers";
import {
  editInPlaceOperation,
  enqueueManagedMessageOperation,
  enqueueWatcherNoteOperation,
  handleQueuedDispatchErrorOperation,
  isInPlaceEditPayload,
  isTransientDispatchFailure,
  onTurnSettledOperation,
  prepareAttachmentsForQueue,
  reconfirmOperation,
  reorderQueueOperation,
  resumeQueueOperation,
  stopAndSendOperation,
  withdrawWatcherNoteOperation,
  type QueueOperationsContext,
} from "./queued-message-operations";

const ADMISSION_RETRY_MS = 1_000;
export const QUEUED_EDIT_GRANT_MS = 120_000;
export const QUEUED_DOCUMENTS_WAIT_FOR_TURN_END = "The agent can't take documents while it works. This message will send when the turn ends.";

type QueueIntake =
  | { kind: "accepted" }
  | { kind: "removed"; removed: QueuedMessage }
  | { kind: "delegated"; hooks: DelegatedQueueHooks; target: QueuedMessage & { delegatedCompletion: DelegatedCompletionAttribution } };

export interface DelegatedQueueHooks {
  automatic(conversationId: string, attribution: DelegatedCompletionAttribution): boolean;
  steerable(conversationId: string, attribution: DelegatedCompletionAttribution): boolean;
  content(attribution: DelegatedCompletionAttribution): string | null;
  dispatched(attribution: DelegatedCompletionAttribution, turnId: string): void;
  steered(attribution: DelegatedCompletionAttribution, turnId: string): void;
  dismiss(entry: QueuedMessage & { delegatedCompletion: DelegatedCompletionAttribution }, requestId: string): Promise<void>;
}

interface QueuedMessageRuntimeOptions {
  signal: AbortSignal;
  track<T>(operation: () => Promise<T>): Promise<T>;
  onWatcherNoteUndelivered?(note: WatcherNoteAttribution, reason: string): void;
  cancelStaleWatcherNote?(conversationId: string, itemId: string): boolean;
  compacting?(conversationId: string): boolean;
  delegated?(): DelegatedQueueHooks | undefined;
}

export const WATCHER_NOTE_REMOVED_REASON = "it was removed from the main chat's queue";
/** It was written for the route its turn ran on and cannot be queued again; Send now re-checks the route. */
export const UNREAD_FOLLOW_UP_ROUTE_CHANGED = "The agent did not read this follow-up, and this chat's model, access or workspace has changed since. Switch back to send it, or remove it.";

export function createQueuedMessageRuntime(
  dependencies: TurnInteractionCommandDependencies,
  options: QueuedMessageRuntimeOptions,
) {
  const { store, turns, conversationAttachments } = dependencies;
  const db = store.orchestration.effects.connection;
  const queue = store.orchestration.queue;
  const runControl = store.orchestration.runControl;

  // Strictly in-flight coalescers / wakeups — zero durable queue state lives in memory.
  const running = new Map<string, Promise<void>>();
  const rescheduled = new Set<string>();
  const retriedManualSend = new Set<string>();
  const enqueueing = new Map<string, Promise<void>>();
  const inFlightEnqueueText = new Map<string, string>();
  const inFlightEditText = new Map<string, string>();
  let recovering: Set<string> | null = null;

  const hasPendingInteraction = (conversationId: string): boolean => {
    for (const approval of dependencies.pendingApprovals.values()) {
      if (approval.conversationId === conversationId) return true;
    }
    for (const input of dependencies.pendingInputs.values()) {
      if (input.conversationId === conversationId) return true;
    }
    return false;
  };

  const result = (conversationId: string, id?: string): MessageQueueResult => buildQueueResult(store, conversationId, {
    id,
    isActive: turns.isActive(conversationId),
    hasPendingInteraction: hasPendingInteraction(conversationId),
  });

  const changed = (conversationId: string): void => {
    dependencies.broadcast({
      type: "conversation.queue.changed",
      conversationId,
      revision: queue.revision(conversationId),
    });
    dependencies.broadcast({ type: "conversation.detail.invalidated", conversationId });
  };

  const requireConversation = (conversationId: string) => {
    const conversation = store.conversation(conversationId);
    if (conversation.archivedAt !== null) throw new RuntimeRequestError("Unarchive this chat before changing its queue.");
    return conversation;
  };

  const undelivered = (entry: { watcherNote?: WatcherNoteAttribution }, reason: string): void => {
    if (!entry.watcherNote) return;
    try { options.onWatcherNoteUndelivered?.(entry.watcherNote, reason); } catch { /* ignore */ }
  };

  const blockItem = (
    conversationId: string,
    entry: { id: string; watcherNote?: WatcherNoteAttribution },
    blockedReason: string,
    detail: string,
  ): void => {
    if (queue.getItem(entry.id)) {
      queue.block({ conversationId, itemId: entry.id, blockedReason, detail });
    } else {
      store.queuedMessages.block(conversationId, entry.id, detail);
    }
    undelivered(entry, detail);
  };

  const claimItem = (
    conversationId: string,
    id: string,
    mode: "run" | "steer" | "after-stop",
  ): { dispatchOrdinal: number; editRevision: number } | null => {
    const v2 = queue.getItem(id);
    if (v2) {
      if (v2.state !== "waiting" || v2.queueHeld) return null;
      const claimed = queue.claim({ conversationId, itemId: id, mode });
      return { dispatchOrdinal: claimed.value.dispatchOrdinal, editRevision: claimed.value.contentRef.editRevision };
    }
    return store.queuedMessages.claim(conversationId, id) ? { dispatchOrdinal: 1, editRevision: 0 } : null;
  };

  const releaseClaimItem = (
    conversationId: string,
    id: string,
    reason: "transient" | "runtime-lost" | "steer-declined" | "turn-ended",
    detail?: string,
  ): boolean => {
    const v2 = queue.getItem(id);
    if (v2) {
      if (v2.state !== "dispatching") return false;
      queue.releaseClaim({ conversationId, itemId: id, reason, detail });
      return true;
    }
    return store.queuedMessages.release(conversationId, id);
  };

  const retryAfterCleanup = (conversationId: string): void => {
    void turns.waitForProviderCleanup([conversationId]).then(() => schedule(conversationId)).catch(() => undefined);
  };

  const retryAfterDelay = (conversationId: string): void => {
    if (options.signal.aborted) return;
    const timer = setTimeout(() => { void schedule(conversationId).catch(() => undefined); }, ADMISSION_RETRY_MS);
    timer.unref?.();
  };

  const waitingDelivery = (
    conversationId: string,
    includeHeld = false,
  ): (QueuedMessage & { delegatedCompletion: DelegatedCompletionAttribution }) | null => {
    const hooks = options.delegated?.();
    const entry = listQueueEntries(store, conversationId).find((item) => item.delegatedCompletion !== undefined);
    const attribution = entry?.delegatedCompletion;
    return hooks && entry && attribution && entry.state === "waiting" && (includeHeld || !entry.queueHeld)
      && hooks.automatic(conversationId, attribution)
      ? { ...entry, delegatedCompletion: attribution } : null;
  };

  const manualTarget = (conversationId: string, manualId: string | undefined): string | undefined => {
    if (manualId === undefined) return undefined;
    const entry = listQueueEntries(store, conversationId).find(({ id }) => id === manualId);
    if (entry?.delegatedCompletion) return manualId;
    return waitingDelivery(conversationId, true)?.id ?? manualId;
  };

  const unreadFollowUpMessage = (conversationId: string, messageId: string) => {
    try {
      const message = store.message(messageId);
      return message.conversationId === conversationId && message.role === "user" && message.turnId !== null ? message : null;
    } catch {
      return null;
    }
  };

  const pendingResumeIntent = (conversationId: string) => {
    const intent = queue.getState(conversationId)?.pendingSendIntent;
    if (intent?.kind !== "resume") return null;
    const retryKey = `${conversationId}:resume:${intent.requestId}`;
    if (retriedManualSend.has(retryKey) || isResumeIntentFulfilled(store, conversationId, intent)) return null;
    return { intent, retryKey };
  };

  const hasDispatchableItem = (conversationId: string): boolean => {
    const hooks = options.delegated?.();
    return listQueueEntries(store, conversationId).some((entry) => {
      if (entry.state !== "waiting" || entry.queueHeld) return false;
      if (entry.delegatedCompletion) return Boolean(hooks?.automatic(conversationId, entry.delegatedCompletion));
      return true;
    });
  };

  const hasPendingWork = (conversationId: string): boolean =>
    hasDispatchableItem(conversationId) || pendingResumeIntent(conversationId) !== null;

  async function dispatch(conversationId: string, requestedId?: string): Promise<boolean> {
    if (options.signal.aborted || !dependencies.enableProviders || turns.isClosing() || turns.isActive(conversationId)) return false;
    if (options.compacting?.(conversationId)) return false;
    if (requestedId === undefined && !hasPendingWork(conversationId)) return false;
    if (!await turns.waitForProviderCleanup([conversationId], Date.now() + 30_000)) {
      retryAfterCleanup(conversationId);
      return false;
    }
    if (options.signal.aborted || turns.isClosing() || turns.isActive(conversationId) || options.compacting?.(conversationId)) return false;
    const conversation = store.conversation(conversationId);
    if (store.orchestration.hasPendingCleanup(conversationId)) {
      retryAfterDelay(conversationId);
      return false;
    }
    if (conversation.archivedAt !== null) return false;
    if (hasIncompleteWorktreeSetup(db, conversationId)) {
      const unheld = queue.listActive(conversationId).filter((item) => !item.queueHeld);
      if (unheld.length > 0) {
        queue.hold({ conversationId, cause: "H3-created-held", itemIds: unheld.map(({ id }) => id) });
        changed(conversationId);
      }
      return false;
    }
    if (isHeld() || store.conversationWork.restoreBlocksConversation(conversationId)) {
      retryAfterDelay(conversationId);
      return false;
    }

    const pendingResume = requestedId === undefined ? pendingResumeIntent(conversationId) : null;
    if (pendingResume && !hasPendingInteraction(conversationId)) {
      const nextSelection = nextQueuedSelectionForConversation(store, conversationId);
      if (!usageLimitHoldsQueue(store, conversationId, nextSelection)) {
        const plan = resolveResumeContinuation(store, conversationId);
        if (plan.kind === "native" || plan.kind === "prompted") {
          try {
            await directTurnInteraction(null as unknown as WebSocket, {
              type: "message.send",
              requestId: `${pendingResume.intent.requestId}:continue`,
              payload: { conversationId, content: plan.content, attachments: [], activate: false },
            }, { kind: "main" });
            retriedManualSend.add(pendingResume.retryKey);
            changed(conversationId);
            return true;
          } catch (error) {
            retriedManualSend.add(pendingResume.retryKey);
            if (isTransientDispatchFailure(error)) retryAfterCleanup(conversationId);
            return false;
          }
        }
      }
    }

    const hooks = options.delegated?.();
    const manualId = manualTarget(conversationId, requestedId);
    const entries = listQueueEntries(store, conversationId);
    const skipped = (entry: QueuedMessage): boolean => entry.id !== manualId && (
      entry.queueHeld === true
      || (entry.delegatedCompletion
        ? manualId !== undefined || entry.state === "blocked" || !hooks?.automatic(conversationId, entry.delegatedCompletion)
        : (entry.watcherNote !== undefined || entry.userMessageId !== null) && entry.state === "blocked")
    );
    const first = entries.find((entry) => !skipped(entry));
    if (!first || (manualId && first.id !== manualId)) return false;
    const isManual = manualId !== undefined;
    if (!isManual && (first.state !== "waiting" || first.queueHeld)) return false;
    if (isManual && first.state === "dispatching") return false;

    const effectiveSelection = resolveEffectiveQueuedSelection(first, conversation);
    const effectiveProviderId = providerIdForHarness(effectiveSelection.harnessId) ?? conversation.providerId;
    if (!isManual && usageLimitHoldsQueue(store, conversationId, effectiveSelection)) return false;
    let manualSendRetryKey: string | null = null;
    if (!isManual) {
      const latestTurn = store.latestAgentTurnForConversation(conversationId);
      const pendingSend = queue.getState(conversationId)?.pendingSendIntent;
      const sendIntentKey = pendingSend?.kind === "send-now" && pendingSend.itemId === first.id
        ? `${conversationId}:${first.id}:${pendingSend.requestId}`
        : null;
      const differentProviderAfterUsageLimit = latestTurn?.status === "failed"
        && store.limitResets.usageLimited(latestTurn.id)
        && effectiveProviderId !== latestTurn.providerId;
      const explicitSendAuthority = first.deliveryMode === "after-stop"
        || (sendIntentKey !== null && !retriedManualSend.has(sendIntentKey))
        || pendingResume !== null
        || differentProviderAfterUsageLimit
        || hasWorktreeRetryReleaseAuthority(store, conversationId, latestTurn);
      if (!explicitSendAuthority && !releasesQueue(latestTurn)) return false;
      if (!releasesQueue(latestTurn) && first.deliveryMode !== "after-stop") {
        if (sendIntentKey !== null) manualSendRetryKey = sendIntentKey;
        else if (pendingResume !== null) manualSendRetryKey = pendingResume.retryKey;
      }
    }
    if (!isManual && first.watcherNote && options.cancelStaleWatcherNote?.(conversationId, first.id)) {
      changed(conversationId);
      return true;
    }
    if (!queueItemRouteMatches(store, first, conversation)) {
      blockItem(
        conversationId,
        first,
        "route-changed",
        first.userMessageId === null ? QUEUED_ROUTE_CHANGED_ERROR : UNREAD_FOLLOW_UP_ROUTE_CHANGED,
      );
      changed(conversationId);
      return false;
    }

    if (isManual && first.queueHeld && queue.getItem(first.id)) {
      queue.release({ conversationId, cause: "R3-resume", itemIds: [first.id] });
    }
    if (isManual && first.state === "blocked" && queue.getItem(first.id)) {
      const v2 = queue.getItem(first.id)!;
      const fallbackContent = first.content || (first.delegatedCompletion ? hooks?.content(first.delegatedCompletion) ?? "" : "");
      queue.edit({
        conversationId,
        itemId: first.id,
        expectedRevision: v2.contentRef.editRevision,
        content: fallbackContent,
        routeIdentity: queuedRouteIdentity(conversation),
      });
    }

    const deliveryMode: "run" | "after-stop" = first.deliveryMode === "after-stop" ? "after-stop" : "run";
    const claim = claimItem(conversationId, first.id, deliveryMode);
    if (!claim) return false;
    // Re-read fresh item content/attachments/selection now that state='dispatching' locks out edits.
    const fresh = listQueueEntries(store, conversationId).find(({ id }) => id === first.id) ?? first;
    const attribution = fresh.delegatedCompletion;
    const unread = fresh.userMessageId === null ? null : unreadFollowUpMessage(conversationId, fresh.userMessageId);
    if (fresh.userMessageId !== null && !unread) {
      blockItem(conversationId, fresh, "missing-follow-up", "This follow-up is no longer in its chat. Remove it and send it again.");
      changed(conversationId);
      return false;
    }
    const content = unread ? unread.content : attribution ? hooks?.content(attribution) ?? null : fresh.content;
    if (content === null) {
      if (queue.getItem(fresh.id)) {
        releaseClaimItem(conversationId, fresh.id, "transient");
        queue.cancel({ conversationId, itemId: fresh.id, reason: "withdrawn" });
        changed(conversationId);
      } else if (store.queuedMessages.withdrawDelegatedDelivery(conversationId, fresh.id)) {
        changed(conversationId);
      }
      return true;
    }
    changed(conversationId);

    const watcherNote = unread ? unread.watcherNote : fresh.watcherNote;
    const delegatedCompletion = unread ? unread.delegatedCompletion : attribution;
    const claimedEntry: QueuedMessage = {
      ...fresh,
      state: "dispatching",
      dispatchOrdinal: claim.dispatchOrdinal,
      editRevision: claim.editRevision,
      deliveryMode,
    };
    const handler = createTurnInteractionCommandHandler({
      ...dependencies,
      queuedMessage: claimedEntry,
      ...(watcherNote ? { watcherDelivery: watcherNoteDelivery(watcherNote) } : {}),
      ...(delegatedCompletion ? { delegatedDelivery: delegatedDelivery(delegatedCompletion) } : {}),
      send: (_socket, _event) => undefined,
    });
    let progressed = false;
    try {
      await handler(null as unknown as WebSocket, {
        type: "message.send",
        requestId: fresh.id,
        payload: { conversationId, content, attachments: [], activate: false },
      });
      const turnId = attribution ? (queue.getItem(fresh.id)?.delivery?.turnId ?? store.queuedMessages.get(conversationId, fresh.id)?.turnId) : null;
      if (attribution && turnId) hooks?.dispatched(attribution, turnId);
      progressed = true;
    } catch (error) {
      handleQueuedDispatchErrorOperation(operationsContext, {
        conversationId,
        entry: fresh,
        claim,
        error,
        aborted: options.signal.aborted,
        manualSendRetryKey,
        unreadRouteChangedError: UNREAD_FOLLOW_UP_ROUTE_CHANGED,
        retriedManualSend,
        releaseClaimItem,
        blockItem,
      });
    } finally {
      changed(conversationId);
    }
    return progressed;
  }

  function schedule(conversationId: string): Promise<void> {
    if (options.signal.aborted || !dependencies.enableProviders) return Promise.resolve();
    if (recovering !== null) {
      recovering.add(conversationId);
      return Promise.resolve();
    }
    const existing = running.get(conversationId);
    if (existing) {
      rescheduled.add(conversationId);
      return existing;
    }
    let admitted = false;
    let progressed = false;
    const task = options.track(async () => {
      admitted = true;
      progressed = await dispatch(conversationId).catch(() => false);
    }).finally(() => {
      running.delete(conversationId);
      const wakeAgain = rescheduled.delete(conversationId);
      if (!admitted) {
        retryAfterDelay(conversationId);
      } else if (wakeAgain && !options.signal.aborted && !turns.isActive(conversationId) && hasPendingWork(conversationId)) {
        void schedule(conversationId).catch(() => undefined);
      } else if (progressed && !options.signal.aborted && !turns.isActive(conversationId) && hasPendingWork(conversationId)) {
        const head = listQueueEntries(store, conversationId).find((entry) => entry.state === "waiting" && !entry.queueHeld);
        const headSelection = head ? resolveEffectiveQueuedSelection(head, store.conversation(conversationId)) : null;
        if (head && !isHeld() && !hasIncompleteWorktreeSetup(db, conversationId) && !usageLimitHoldsQueue(store, conversationId, headSelection)) {
          const latest = store.latestAgentTurnForConversation(conversationId);
          const pendingSend = queue.getState(conversationId)?.pendingSendIntent;
          const explicit = head.deliveryMode === "after-stop"
            || (pendingSend?.kind === "send-now" && pendingSend.itemId === head.id)
            || pendingResumeIntent(conversationId) !== null
            || hasWorktreeRetryReleaseAuthority(store, conversationId, latest);
          if (explicit || releasesQueue(latest)) void schedule(conversationId).catch(() => undefined);
        }
      }
    });
    running.set(conversationId, task);
    return task;
  }

  const insertNow: QueuedMessagePersistence = async (insert) => { insert(); };
  async function enqueue(
    input: { conversationId: string; id: string; content: string; attachments: ChatAttachment[] },
    handoffId: string,
    persist: QueuedMessagePersistence = insertNow,
    extra: {
      placement?: "end" | "front" | { afterItemIds: string[] };
      queueHeld?: boolean;
      skipHoldInheritance?: true;
      steerFollowUpOfRunId?: string;
      steerWhenReadyRunId?: string;
      modelSelection?: ModelSelection | null;
      source?: CommandSource;
    } = {},
  ): Promise<void> {
    const previous = enqueueing.get(input.id);
    if (previous) {
      await previous;
      queue.verifyEnqueueReplay(input.conversationId, input.id, input.content, input.attachments);
      return;
    }
    const operation = (async () => {
      const conversation = requireConversation(input.conversationId);
      if (queue.getItem(input.id)) {
        queue.verifyEnqueueReplay(conversation.id, input.id, input.content, input.attachments);
        return;
      }
      if (!dependencies.enableProviders) throw new RuntimeRequestError("Message queues require an available provider runtime.");
      if (isUserQueueFull(store, conversation.id)) {
        throw new RuntimeRequestError(`This chat already has ${MAX_QUEUED_USER_AND_AGENT_ITEMS} queued messages. Remove one and try again.`);
      }
      const prepared = await prepareAttachmentsForQueue(dependencies, input.attachments, handoffId);
      let persisted = false;
      try {
        options.signal.throwIfAborted();
        await persist(() => {
          const current = requireConversation(conversation.id);
          const selection = resolveQueueTailSelection(store, current, extra.modelSelection);
          const worktreeIncomplete = hasIncompleteWorktreeSetup(db, current.id);
          const queueHeld = extra.queueHeld !== undefined ? extra.queueHeld : (worktreeIncomplete ? true : undefined);
          queue.enqueue({
            conversationId: current.id,
            itemId: input.id,
            content: input.content,
            attachments: prepared.attachments,
            kind: "message",
            createdBy: "user",
            creationSource: "web",
            routeIdentity: routeIdentityForSelection(current, selection),
            modelSelection: selection,
            ...(extra.placement !== undefined ? { placement: extra.placement } : {}),
            ...(queueHeld !== undefined ? { queueHeld } : {}),
            ...(extra.skipHoldInheritance !== undefined ? { skipHoldInheritance: extra.skipHoldInheritance } : {}),
            ...(extra.steerFollowUpOfRunId !== undefined ? { steerFollowUpOfRunId: extra.steerFollowUpOfRunId } : {}),
            ...(extra.steerWhenReadyRunId !== undefined ? { steerWhenReadyRunId: extra.steerWhenReadyRunId } : {}),
            origin: "command",
            source: extra.source,
          });
        });
        persisted = true;
        await prepared.accept();
      } finally {
        if (!persisted) await prepared.release();
      }
      changed(conversation.id);
    })();
    enqueueing.set(input.id, operation);
    try { await operation; } finally { enqueueing.delete(input.id); }
  }

  const undeliveredQueueFull = (): RuntimeRequestError => new RuntimeRequestError(
    `This follow-up did not reach the agent, and this chat already has ${MAX_QUEUED_USER_AND_AGENT_ITEMS} queued messages. Remove one and send it again.`,
  );

  const undeliveredFollowUps: NonNullable<TurnInteractionCommandDependencies["undeliveredFollowUps"]> = {
    async enqueue(input, handoffId, persist) {
      const hint = takeFollowUpQueueHint(input.id);
      if (isUserQueueFull(store, input.conversationId)) throw undeliveredQueueFull();
      await enqueue(input, handoffId, persist, {
        ...(hint?.placement ? { placement: hint.placement } : {}),
        ...(hint?.steerFollowUpOfRunId ? { steerFollowUpOfRunId: hint.steerFollowUpOfRunId } : {}),
        ...(hint?.steerWhenReadyRunId ? { steerWhenReadyRunId: hint.steerWhenReadyRunId } : {}),
        ...(hint?.queueHeld !== undefined ? { queueHeld: hint.queueHeld } : {}),
      }).catch((error: unknown) => {
        throw error instanceof QueuedMessageLimitError ? undeliveredQueueFull() : error;
      });
      void schedule(input.conversationId).catch(() => undefined);
      return result(input.conversationId, input.id);
    },
    adopt(input, unconfirmed) {
      const hint = takeFollowUpQueueHint(input.id);
      const conversation = requireConversation(input.conversationId);
      if (isUserQueueFull(store, conversation.id)) throw undeliveredQueueFull();
      if (hint?.releaseHoldsR1) {
        const held = queue.listActive(conversation.id).filter((item) => item.queueHeld);
        if (held.length > 0) queue.release({ conversationId: conversation.id, cause: "R1-user-send" });
      }
      const selection = resolveQueueTailSelection(store, conversation);
      const worktreeIncomplete = hasIncompleteWorktreeSetup(db, conversation.id);
      const queueHeld = hint?.queueHeld !== undefined ? hint.queueHeld : (worktreeIncomplete ? true : undefined);
      try {
        queue.enqueue({
          conversationId: conversation.id,
          itemId: input.id,
          content: input.content,
          attachments: input.attachments,
          kind: "message",
          createdBy: "user",
          creationSource: "web",
          routeIdentity: routeIdentityForSelection(conversation, selection),
          modelSelection: selection,
          ...(hint?.placement ? { placement: hint.placement } : {}),
          ...(hint?.steerFollowUpOfRunId ? { steerFollowUpOfRunId: hint.steerFollowUpOfRunId } : {}),
          ...(queueHeld !== undefined ? { queueHeld } : {}),
          origin: "command",
        });
      } catch (error) {
        throw error instanceof QueuedMessageLimitError ? undeliveredQueueFull() : error;
      }
      if (unconfirmed) {
        queue.block({ conversationId: conversation.id, itemId: input.id, blockedReason: "steer-unconfirmed", detail: unconfirmed });
      }
      changed(conversation.id);
      void schedule(conversation.id).catch(() => undefined);
      return result(conversation.id, input.id);
    },
    result,
  };

  const enqueueWatcherNote = (input: { conversationId: string; id: string; content: string; watcherNote: WatcherNoteAttribution }): MessageQueueResult =>
    enqueueWatcherNoteOperation(operationsContext, input);
  const enqueueManagedMessage = (input: { conversationId: string; id: string; content: string }): MessageQueueResult =>
    enqueueManagedMessageOperation(operationsContext, input);
  const withdrawWatcherNote = (conversationId: string, id: string): boolean =>
    withdrawWatcherNoteOperation(operationsContext, conversationId, id);

  async function sendDuringTurn(conversationId: string, id: string, requestId: string): Promise<void> {
    const conversation = requireConversation(conversationId);
    const entries = listQueueEntries(store, conversationId);
    const target = entries.find((entry) => entry.id === id);
    if (!target) throw new RuntimeRequestError("This queued message is no longer in the queue.");
    if (target.delegatedCompletion) {
      throw new RuntimeRequestError("Delegated results continue this chat after the current turn ends.");
    }
    if (target.userMessageId) {
      throw new RuntimeRequestError("This follow-up sends as its own turn when the current turn ends.");
    }
    const first = entries.find((entry) => !entry.delegatedCompletion);
    if (!first || first.id !== id) throw new RuntimeRequestError("Send the first queued message first.");
    if (first.state === "dispatching") return;
    if (!queueItemRouteMatches(store, first, conversation)) {
      blockItem(conversationId, first, "route-changed", QUEUED_ROUTE_CHANGED_ERROR);
      changed(conversationId);
      return;
    }
    if (first.attachments.some(({ mimeType }) => chatAttachmentKind(mimeType) !== "image")) {
      throw new RuntimeRequestError(QUEUED_DOCUMENTS_WAIT_FOR_TURN_END);
    }
    const admission = turns.acquireFollowUpAdmission(conversationId);
    if (!admission) throw new RuntimeRequestError("This agent cannot take a message while it works. It will send when the turn ends.");
    let claimed = false;
    let acknowledged = false;
    let steerEffectId: string | null = null;
    try {
      if (first.attachments.length > 0 && !admission.supportsImages) {
        throw new RuntimeRequestError("The active model cannot inspect follow-up images. It will send when the turn ends.");
      }
      const deadline = messageSendPreparationDeadline();
      const attachments: ChatAttachment[] = [];
      for (const attachment of first.attachments) {
        const preview = await awaitMessageSendPreparation(conversationAttachments.resolve(attachment.id), deadline);
        if (!preview) throw new RuntimeRequestError("A queued image is no longer available. Remove this message and attach it again.");
        attachments.push({
          ...preview.attachment,
          ...(attachment.snapshot ? { snapshot: attachment.snapshot } : {}),
          ...(attachment.previewAnnotation ? { previewAnnotation: attachment.previewAnnotation } : {}),
        });
      }
      const claim = claimItem(conversationId, first.id, "steer");
      if (!claim) return;
      claimed = true;
      changed(conversationId);

      const steerStart = await store.orchestration.authority.begin<{ kind: "requested"; effectId: string } | { kind: "closed" } | { kind: "untracked" }>({
        source: {
          actorId: "runtime",
          commandId: `queue-steer:${first.id}:${claim.dispatchOrdinal}:${requestId}`,
          command: { type: "queue.steer", conversationId, itemId: first.id, dispatchOrdinal: claim.dispatchOrdinal },
        },
        threadId: conversation.id,
        projectId: conversation.projectId,
        commandType: "queue.steer",
        rejection: null,
      }, (steerTicket) => runControl.requestSteer(steerTicket, admission.runId, admission.turnId, { queuedMessageId: first.id }));

      if (steerStart.kind === "lead") {
        if (steerStart.intake.kind === "requested") {
          steerEffectId = steerStart.intake.effectId;
          bindSteerEffectId(admission, steerEffectId);
        }
        steerStart.ticket.finish(null);
      }
      const steerClosed = steerStart.kind === "lead" && steerStart.intake.kind === "closed";
      const steered = steerClosed
        ? { kind: "turn-ended" as const }
        : await executeSteerViaEffectRuntime(
          store,
          steerEffectId,
          () => turns.steer(
            admission,
            { content: first.content, imagePaths: attachments.map(({ path }) => path) },
            attachments,
            () => { acknowledged = true; },
            AbortSignal.timeout(Math.max(0, deadline - Date.now())),
            {
              queuedMessageId: first.id,
              ...(first.watcherNote
                ? { providerContent: watcherSteerContent(first.content, first.watcherNote), watcherNote: first.watcherNote }
                : {}),
            },
          ),
        );

      if (steered.kind === "accepted") {
        claimed = false;
        if (steerEffectId) runControl.settleSteer(steerEffectId, "accepted", { messageId: steered.message.id, queuedMessageId: first.id });
        if (queue.getItem(first.id)) {
          const targetRun = runControl.target(admission.runId);
          queue.deliver({
            conversationId,
            itemId: first.id,
            delivery: {
              mode: "steer",
              runId: admission.runId,
              attemptId: targetRun?.attemptId ?? admission.runId,
              turnId: admission.turnId,
              messageId: steered.message.id,
              ...(steerEffectId ? { steerEffectId } : {}),
              deliveredAt: steered.message.createdAt,
            },
          });
        }
        dependencies.broadcast({ type: "conversation.message.persisted", message: steered.message });
        dependencies.broadcastSnapshot();
        return;
      }
      if (steered.kind === "unconfirmed") {
        claimed = false;
        if (steerEffectId) runControl.settleSteer(steerEffectId, "unconfirmed", { queuedMessageId: first.id });
        blockItem(conversationId, first, "steer-unconfirmed", steered.message);
        return;
      }
      if (steerEffectId) runControl.settleSteer(steerEffectId, steered.kind === "turn-ended" ? "turn-ended" : "refused", { queuedMessageId: first.id });
      releaseClaimItem(conversationId, first.id, steered.kind === "turn-ended" ? "turn-ended" : "steer-declined");
      claimed = false;
      if (steered.kind === "turn-ended") {
        if (queue.getItem(first.id)?.queueHeld) {
          queue.release({ conversationId, cause: "R3-resume", itemIds: [first.id] });
        }
        retryAfterCleanup(conversationId);
      }
      else throw new RuntimeRequestError("The agent did not take this message now. It will send when the turn ends.");
    } catch (error) {
      if (steerEffectId) runControl.settleSteer(steerEffectId, acknowledged ? "unconfirmed" : "unavailable", { queuedMessageId: first.id });
      if (claimed) {
        if (acknowledged) {
          blockItem(conversationId, first, "steer-unconfirmed", "The agent received this message, but Inertia could not record it. Check the chat before sending it again.");
        } else if (error instanceof RuntimeRequestError && error.delivery === "ambiguous") {
          blockItem(conversationId, first, "steer-unconfirmed", publicRuntimeError(error));
        } else {
          releaseClaimItem(conversationId, first.id, "steer-declined");
        }
      }
      throw error;
    } finally {
      admission.release();
      changed(conversationId);
    }
  }

  /** Validates `message.queue.send` BEFORE committing any receipt (Audit 3 Bug #5). */
  function validateManualSend(conversationId: string, id: string): void {
    requireConversation(conversationId);
    if (hasIncompleteWorktreeSetup(db, conversationId)) {
      throw new RuntimeRequestError(RESUME_WORKTREE_SETUP_ERROR);
    }
    const entries = listQueueEntries(store, conversationId);
    const target = entries.find((entry) => entry.id === id);
    if (!target) throw new RuntimeRequestError("This queued message is no longer in the queue.");
    if (turns.isActive(conversationId)) {
      if (target.delegatedCompletion) {
        throw new RuntimeRequestError("Delegated results continue this chat after the current turn ends.");
      }
      if (target.userMessageId) {
        throw new RuntimeRequestError("This follow-up sends as its own turn when the current turn ends.");
      }
      const first = entries.find((entry) => !entry.delegatedCompletion);
      if (!first || first.id !== id) throw new RuntimeRequestError("Send the first queued message first.");
      if (target.attachments.some(({ mimeType }) => chatAttachmentKind(mimeType) !== "image")) {
        throw new RuntimeRequestError(QUEUED_DOCUMENTS_WAIT_FOR_TURN_END);
      }
    }
  }

  const directTurnInteraction = createTurnInteractionCommandHandler({ ...dependencies, undeliveredFollowUps });
  const operationsContext: QueueOperationsContext = {
    dependencies,
    running,
    inFlightEditText,
    isCompacting: (conversationId) => options.compacting?.(conversationId) === true,
    requireConversation,
    hasPendingInteraction,
    result,
    changed,
    schedule,
    retryAfterCleanup,
    dispatch: async (conversationId, requestedId) => { await dispatch(conversationId, requestedId); },
    directTurnInteraction,
  };

  const handler = defineRuntimeCommandHandler([
    "message.queue.get",
    "message.queue.enqueue",
    "message.queue.remove",
    "message.queue.send",
    "message.queue.stop-and-send",
    "message.queue.edit",
    "message.queue.reconfirm",
    "message.queue.resume" as ClientCommand["type"],
    "message.queue.reorder" as ClientCommand["type"],
  ], async (socket, command) => {
    const rawType = command.type as string;
    if (!rawType.startsWith("message.queue.")) return "not-handled";

    const sendResult = (queueResult: MessageQueueResult): "handled" => {
      const event: ServerEvent = { type: "request.result", requestId: command.requestId, result: queueResult };
      dependencies.send(socket, event);
      return "handled";
    };

    if (rawType === "message.queue.resume") {
      const { conversationId } = (command as unknown as { payload: { conversationId: string } }).payload;
      return sendResult(await resumeQueueOperation(operationsContext, conversationId, command.requestId, socket));
    }
    if (rawType === "message.queue.reorder") {
      const { conversationId, id, beforeId } = (command as unknown as { payload: { conversationId: string; id: string; beforeId: string | null } }).payload;
      return sendResult(await reorderQueueOperation(operationsContext, conversationId, id, beforeId, command.requestId));
    }

    if (command.type !== "message.queue.get" && command.type !== "message.queue.enqueue" && command.type !== "message.queue.remove"
      && command.type !== "message.queue.send" && command.type !== "message.queue.stop-and-send"
      && command.type !== "message.queue.edit" && command.type !== "message.queue.reconfirm") return "not-handled";

    const { conversationId } = command.payload;
    const conversation = store.conversation(conversationId);
    if ((command.type === "message.queue.send" || command.type === "message.queue.stop-and-send" || command.type === "message.queue.reconfirm") && isHeld()) {
      throw new RuntimeRequestError(UPDATE_HOLD_MESSAGE);
    }
    if ((command.type === "message.queue.send" || command.type === "message.queue.stop-and-send" || command.type === "message.queue.reconfirm")
      && store.conversationWork.restoreBlocksConversation(conversationId)) {
      throw new RuntimeRequestError(CHECKOUT_RESTORE_IN_PROGRESS);
    }
    if (command.type === "message.queue.edit") {
      if (!isInPlaceEditPayload(command.payload)) {
        throw new RuntimeRequestError("Editing a queued message requires updated content and expectedRevision.");
      }
      const source: CommandSource = {
        actorId: "human",
        commandId: command.requestId,
        command: JSON.parse(JSON.stringify(command)) as JsonValue,
      };
      return sendResult(await editInPlaceOperation(operationsContext, command.payload, command.requestId, source));
    }
    if (command.type === "message.queue.reconfirm") {
      await reconfirmOperation(operationsContext, conversationId, command.payload.id);
      return sendResult(result(conversationId, command.payload.id));
    }
    const reply = (id?: string): "handled" => sendResult(result(conversationId, id));
    if (command.type === "message.queue.get") return reply(command.payload.id);

    const source: CommandSource = {
      actorId: "human",
      commandId: command.requestId,
      command: JSON.parse(JSON.stringify(command)) as JsonValue,
    };
    const inFlightKey = `${conversation.id}:${command.requestId}`;
    const start = await store.orchestration.authority.begin<QueueIntake>({
      source,
      threadId: conversation.id,
      projectId: conversation.projectId,
      commandType: command.type,
      rejection: commandRejection,
      verifyReplayContent: command.type === "message.queue.enqueue" || command.type === "message.queue.stop-and-send"
        ? (receipt) => {
            if (receipt === null) {
              const activeText = inFlightEnqueueText.get(inFlightKey);
              if (activeText !== undefined && activeText !== command.payload.content.trim()) {
                throw new OrchestrationConflict("command-conflict");
              }
              return;
            }
            queue.verifyEnqueueReplay(conversation.id, command.payload.id, command.payload.content, command.payload.attachments);
          }
        : undefined,
    }, (ticket) => {
      if (command.type === "message.queue.enqueue" || command.type === "message.queue.stop-and-send") {
        inFlightEnqueueText.set(inFlightKey, command.payload.content.trim());
      }
      return queueIntake(command, ticket);
    });

    if (start.kind === "rejected") throw new RuntimeRequestError(start.detail);
    if (start.kind === "joined") {
      await start.result;
      return reply(command.payload.id);
    }
    if (start.kind === "replay") {
      if (command.type === "message.queue.stop-and-send") retryAfterCleanup(conversationId);
      else void schedule(conversationId).catch(() => undefined);
      return reply(command.payload.id);
    }

    const { ticket, intake } = start;
    try {
      if (command.type === "message.queue.enqueue") {
        let recorded = false;
        await enqueue(command.payload, command.requestId, (insert) => ticket.inLane(() => {
          insert();
          if (!queue.getItem(command.payload.id)) {
            ticket.commit({ events: [], result: { queued: command.payload.id } });
          }
          recorded = true;
        }), { source });
        if (!recorded) await ticket.inLane(() => ticket.commit({ events: [], result: { queued: command.payload.id } }));
        void schedule(conversationId).catch(() => undefined);
      } else if (intake.kind === "delegated") {
        const target = intake.target;
        await intake.hooks.dismiss(target, command.requestId);
        if (listQueueEntries(store, conversationId).some(({ id }) => id === target.id)) {
          throw new RuntimeRequestError("These delegated results have already been sent.");
        }
        await ticket.inLane(() => {
          const existing = queue.getItem(target.id);
          if (existing && (existing.state === "waiting" || existing.state === "blocked")) {
            queue.cancel({ conversationId, itemId: target.id, reason: "user", source });
          } else {
            ticket.commit({ events: [], result: { removed: target.id } });
          }
        });
        changed(conversationId);
        void schedule(conversationId).catch(() => undefined);
      } else if (intake.kind === "removed") {
        const removed = intake.removed;
        undelivered(removed, WATCHER_NOTE_REMOVED_REASON);
        const candidates = removed.attachments.map(({ id }) => id);
        const referenced = store.referencedAttachmentIds(candidates);
        await conversationAttachments.release(candidates.filter((id) => !referenced.has(id)));
        changed(conversationId);
        void schedule(conversationId).catch(() => undefined);
      } else if (command.type === "message.queue.send") {
        await running.get(conversationId)?.catch(() => undefined);
        if (turns.isActive(conversationId)) await sendDuringTurn(conversationId, command.payload.id, command.requestId);
        else await dispatch(conversationId, command.payload.id);
      } else if (command.type === "message.queue.stop-and-send") {
        await stopAndSendOperation(operationsContext, command.payload, command.requestId, ticket);
      }
    } catch (error) {
      ticket.fail(error);
      throw error;
    } finally {
      inFlightEnqueueText.delete(inFlightKey);
    }
    ticket.finish(null);
    return reply(command.payload.id);
  });

  function queueIntake(
    command: Extract<ClientCommand, { type: "message.queue.enqueue" | "message.queue.remove" | "message.queue.send" | "message.queue.stop-and-send" }>,
    ticket: CommandTicket,
  ): QueueIntake {
    const { conversationId } = command.payload;
    if (command.type === "message.queue.remove") {
      requireConversation(conversationId);
      const target = listQueueEntries(store, conversationId).find(({ id }) => id === command.payload.id);
      const hooks = options.delegated?.();
      if (target?.delegatedCompletion && hooks) {
        return { kind: "delegated", hooks, target: { ...target, delegatedCompletion: target.delegatedCompletion } };
      }
      if (!target || target.state === "dispatching") {
        throw new RuntimeRequestError("This queued message has already been dispatched.");
      }
      const v2 = queue.getItem(command.payload.id);
      if (v2) {
        ticket.commit({
          events: [{ type: "queue.item-cancelled", payload: { itemId: v2.id, reason: "user" } }],
          result: { removed: v2.id },
        }, () => {
          db.prepare("UPDATE queued_messages SET state = 'cancelled', content = '', attachments_json = '[]', error = NULL, queue_position = NULL, queue_held = 0 WHERE id = ? AND conversation_id = ?")
            .run(v2.id, conversationId);
          queue.pruneTerminal(conversationId);
        });
        return { kind: "removed", removed: target };
      }
      let removed: QueuedMessage | null = null;
      ticket.commit({ events: [], result: { removed: command.payload.id } }, () => {
        removed = store.queuedMessages.cancel(conversationId, command.payload.id);
        if (!removed) throw new RuntimeRequestError("This queued message has already been dispatched.");
      });
      return { kind: "removed", removed: removed! };
    }
    if (command.type === "message.queue.send") {
      validateManualSend(conversationId, command.payload.id);
      const v2 = queue.getItem(command.payload.id);
      const activeInV2 = v2 !== null && (v2.state === "waiting" || v2.state === "blocked");
      ticket.commit({
        events: activeInV2 ? [{
          type: "queue.send-requested",
          payload: {
            itemId: command.payload.id,
            kind: "send-now",
            requestedAt: new Date().toISOString(),
            requestId: command.requestId,
          },
        }] : [],
        result: { send: command.payload.id },
      });
    } else if (command.type === "message.queue.stop-and-send") {
      requireConversation(conversationId);
    }
    return { kind: "accepted" };
  }

  async function steerDelegated(conversationId: string): Promise<boolean> {
    const hooks = options.delegated?.();
    const entry = waitingDelivery(conversationId);
    const attribution = entry?.delegatedCompletion;
    if (!hooks || !entry || !attribution || entry.userMessageId !== null || entry.state !== "waiting"
      || !hooks.steerable(conversationId, attribution)) return false;
    const content = hooks.content(attribution);
    if (content === null) return false;
    const admission = turns.acquireFollowUpAdmission(conversationId);
    if (!admission) return false;
    let claimed = false;
    try {
      const claim = claimItem(conversationId, entry.id, "steer");
      if (!claim) return false;
      claimed = true;
      changed(conversationId);
      const steered = await turns.steer(
        admission,
        { content, imagePaths: [] },
        [],
        undefined,
        AbortSignal.timeout(Math.max(0, messageSendPreparationDeadline() - Date.now())),
        { queuedMessageId: entry.id, providerContent: delegatedSteerContent(content), delegatedCompletion: attribution },
      );
      claimed = false;
      if (steered.kind === "accepted") {
        if (queue.getItem(entry.id)) {
          const targetRun = runControl.target(admission.runId);
          queue.deliver({
            conversationId,
            itemId: entry.id,
            delivery: {
              mode: "steer",
              runId: admission.runId,
              attemptId: targetRun?.attemptId ?? admission.runId,
              turnId: admission.turnId,
              messageId: steered.message.id,
              deliveredAt: steered.message.createdAt,
            },
          });
        }
        hooks.steered(attribution, admission.turnId);
        dependencies.broadcast({ type: "conversation.message.persisted", message: steered.message });
        dependencies.broadcastSnapshot();
        return true;
      }
      releaseClaimItem(conversationId, entry.id, steered.kind === "turn-ended" ? "turn-ended" : "steer-declined");
      void schedule(conversationId).catch(() => undefined);
      return false;
    } catch {
      if (claimed) releaseClaimItem(conversationId, entry.id, "steer-declined");
      void schedule(conversationId).catch(() => undefined);
      return false;
    } finally {
      admission.release();
      changed(conversationId);
    }
  }

  async function promoteDeferredSteers(conversationId: string, runId: string, attemptId: string): Promise<void> {
    const items = listQueueEntries(store, conversationId)
      .filter((entry) => entry.state === "waiting" && !entry.queueHeld && entry.steerWhenReadyRunId === runId);
    for (const item of items) {
      db.prepare("UPDATE queued_messages SET steer_when_ready_run_id = NULL WHERE id = ? AND conversation_id = ?")
        .run(item.id, conversationId);
      if (!turns.isActive(conversationId)) break;
      try {
        await sendDuringTurn(conversationId, item.id, queueDeferredSteerCommandId(item.id, runId, attemptId));
      } catch {
        // Leave item waiting in queue for turn end.
      }
    }
  }

  const sendsBeforeDirectMessage = (conversationId: string): QueuedMessage | null => {
    const delivery = waitingDelivery(conversationId, true);
    if (delivery) return delivery;
    const entries = listQueueEntries(store, conversationId)
      .filter((entry) => !entry.delegatedCompletion && (!entry.queueHeld || entry.userMessageId !== null));
    const head = entries[0];
    return head && (head.state === "waiting" || head.state === "dispatching") ? head : null;
  };

  async function queueBehindDelivery(
    socket: WebSocket,
    command: Extract<ClientCommand, { type: "message.send" }>,
  ): Promise<boolean> {
    const { conversationId, content, attachments, context } = command.payload;
    if (!dependencies.enableProviders || isHeld() || context !== undefined || turns.isActive(conversationId)) return false;
    if (hasIncompleteWorktreeSetup(db, conversationId)) return false;
    const delivery = sendsBeforeDirectMessage(conversationId);
    if (!delivery || attachments.some(({ mimeType }) => chatAttachmentKind(mimeType) !== "image")) return false;
    if (!queue.getItem(command.requestId) && isUserQueueFull(store, conversationId)) {
      if (!delivery.delegatedCompletion) return false;
      throw new RuntimeRequestError("Delegated results continue this chat first, and its queue is full. Remove a queued message and send again.");
    }
    const heldBeforeSend = queue.listActive(conversationId).filter((item) => item.queueHeld);
    if (heldBeforeSend.length > 0) {
      queue.release({ conversationId, cause: "R1-user-send" });
    }
    await enqueue({ conversationId, id: command.requestId, content, attachments }, command.requestId, undefined, {
      queueHeld: false,
      skipHoldInheritance: true,
    });
    await running.get(conversationId)?.catch(() => undefined);
    const currentDelivery = listQueueEntries(store, conversationId).find(({ id }) => id === delivery.id);
    if (currentDelivery?.state === "waiting") await dispatch(conversationId, delivery.id);
    for (let attempt = 0; attempt <= MAX_QUEUED_USER_AND_AGENT_ITEMS + 1 && !turns.isActive(conversationId); attempt += 1) {
      const own = listQueueEntries(store, conversationId).find(({ id }) => id === command.requestId);
      if (own?.state !== "waiting") break;
      if (own.queueHeld && queue.getItem(own.id)) {
        queue.release({ conversationId, cause: "R1-user-send", itemIds: [own.id] });
      }
      const head = listQueueEntries(store, conversationId)
        .find((entry) => !entry.delegatedCompletion && !entry.queueHeld && entry.state === "waiting");
      if (!head) break;
      await running.get(conversationId)?.catch(() => undefined);
      await dispatch(conversationId, head.id);
      const after = listQueueEntries(store, conversationId).find(({ id }) => id === head.id);
      if (after?.state === "waiting") break;
    }
    dependencies.send(socket, { type: "request.result", requestId: command.requestId, result: result(conversationId, command.requestId) });
    return true;
  }

  const turnInteractionHandler = defineRuntimeCommandHandler(directTurnInteraction.commandTypes ?? [],
    async (socket, command, authority) => {
      if (command.type === "message.send" && await queueBehindDelivery(socket, command)) return "handled";
      return await directTurnInteraction(socket, command, authority);
    });

  return {
    handler,
    turnInteractionHandler,
    resume: (conversationId: string, requestId: string) => resumeQueueOperation(operationsContext, conversationId, requestId),
    reorder: (conversationId: string, id: string, beforeId: string | null, requestId: string) =>
      reorderQueueOperation(operationsContext, conversationId, id, beforeId, requestId),
    sendNow: async (conversationId: string, id: string, requestId: string): Promise<void> => {
      await running.get(conversationId)?.catch(() => undefined);
      if (turns.isActive(conversationId)) await sendDuringTurn(conversationId, id, requestId);
      else await dispatch(conversationId, id);
    },
    promoteDeferredSteers,
    async offerDelegated(conversationId: string): Promise<void> {
      const legacy = store.queuedMessages.activeDelegatedDelivery(conversationId);
      if (legacy && !queue.getItem(legacy.id) && legacy.delegatedCompletion) {
        db.prepare("DELETE FROM queued_messages WHERE id = ? AND conversation_id = ?").run(legacy.id, conversationId);
        queue.enqueue({
          conversationId,
          itemId: legacy.id,
          content: legacy.content,
          attachments: [],
          kind: "delegated-results",
          createdBy: "system",
          creationSource: "server",
          followsThreadSelection: true,
          attribution: { delegatedCompletion: legacy.delegatedCompletion },
          origin: "automatic",
        });
        changed(conversationId);
      }
      if (turns.isActive(conversationId)) {
        await steerDelegated(conversationId);
        return;
      }
      await schedule(conversationId);
    },
    async sendDelegated(conversationId: string): Promise<void> {
      await running.get(conversationId)?.catch(() => undefined);
      const entry = listQueueEntries(store, conversationId).find((item) => item.delegatedCompletion !== undefined);
      if (!entry) throw new RuntimeRequestError("No delegated results are waiting to be sent.");
      if (turns.isActive(conversationId)) return;
      await dispatch(conversationId, entry.id);
    },
    enqueueWatcherNote,
    enqueueManagedMessage,
    withdrawWatcherNote,
    editedAttachmentConversations: (_attachmentId: string): string[] => [],
    editedAttachmentMetadata: (_attachmentId: string) => null,
    onTurnSettled(turn: AgentTurn): void {
      onTurnSettledOperation(operationsContext, turn, hasDispatchableItem);
    },
    onCompactionSettled(conversationId: string): void {
      if (hasPendingWork(conversationId)) void schedule(conversationId).catch(() => undefined);
    },
    onWorktreeSetupRetried(conversationId: string): void {
      if (turns.isActive(conversationId) || !canReleaseWorktreeSetupRetry(store, conversationId)) return;
      const released = queue.release({ conversationId, cause: "R4-preparation-retry" });
      if (released.events.length > 0) {
        changed(conversationId);
        void schedule(conversationId).catch(() => undefined);
      }
    },
    async start(beforeSchedule?: () => void | Promise<void>): Promise<void> {
      await reconcileQueueOnBoot(store);
      const held = new Set<string>();
      recovering = held;
      try {
        await beforeSchedule?.();
      } finally {
        recovering = null;
      }
      const pending = new Set([...store.queuedMessages.pendingConversationIds(), ...held]);
      for (const conversationId of pending) {
        if (hasDispatchableItem(conversationId)) {
          void schedule(conversationId).catch(() => undefined);
        }
      }
    },
  };
}
