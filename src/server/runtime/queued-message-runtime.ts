import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import type { AgentTurn, ChatAttachment, ClientCommand, ServerEvent } from "../../shared/contracts";
import { chatAttachmentKind } from "../../shared/attachments";
import { MAX_QUEUED_MESSAGES, type MessageQueueResult, type QueuedMessage } from "../../shared/queued-messages";
import type { DelegatedCompletionAttribution } from "../../shared/orchestration-delegation";
import { QueuedMessageLimitError, queuedIntentDigest, queuedRouteIdentity } from "../persistence/queued-message-repository";
import { MESSAGE_ADMISSION_UNAVAILABLE, publicRuntimeError, RuntimeRequestError } from "../runtime-errors";
import { defineRuntimeCommandHandler } from "./commands/command-router";
import { createTurnInteractionCommandHandler, type TurnInteractionCommandDependencies } from "./commands/turn-interaction-commands";
import {
  awaitMessageSendPreparation, MessageSendPreparationTimeoutError, messageSendPreparationDeadline,
} from "./commands/message-send-preparation";
import { isHeld, UPDATE_HOLD_MESSAGE } from "./update-hold";
import { CHECKOUT_RESTORE_IN_PROGRESS } from "./conversation-work-authority";
import type { WatcherNoteAttribution } from "../../shared/watcher";
import { watcherNoteDelivery, watcherSteerContent } from "./watcher/watcher-note-instruction";
import { delegatedDelivery, delegatedSteerContent } from "./delegation/delivery-instruction";

const ADMISSION_RETRY_MS = 1_000;

function releasesQueue(turn: Pick<AgentTurn, "status" | "terminalReason"> | null): boolean {
  return turn?.status === "completed" || (turn?.status === "interrupted" && turn.terminalReason === "app-update");
}

const transientDispatchFailure = (error: unknown): boolean => error instanceof MessageSendPreparationTimeoutError
  || (error instanceof RuntimeRequestError && error.code === MESSAGE_ADMISSION_UNAVAILABLE);

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
  compacting?(conversationId: string): boolean;
  delegated?(): DelegatedQueueHooks | undefined;
}

export const WATCHER_NOTE_REMOVED_REASON = "it was removed from the main chat's queue";

export function createQueuedMessageRuntime(
  dependencies: TurnInteractionCommandDependencies,
  options: QueuedMessageRuntimeOptions,
) {
  const { store, turns, conversationAttachments } = dependencies;
  const running = new Map<string, Promise<void>>();
  const enqueueing = new Map<string, Promise<void>>();
  const again = new Set<string>();
  const deferred = new Set<string>();
  const manualRetries = new Map<string, string>();
  let recovering: Set<string> | null = null;
  const result = (conversationId: string, id?: string): MessageQueueResult => ({
    kind: "message.queue", conversationId, entries: store.queuedMessages.list(conversationId),
    receipt: id ? store.queuedMessages.get(conversationId, id) : null,
  });
  const changed = (conversationId: string): void => {
    dependencies.broadcast({ type: "conversation.detail.invalidated", conversationId });
  };
  const requireConversation = (conversationId: string) => {
    const conversation = store.conversation(conversationId);
    if (conversation.archivedAt !== null) throw new RuntimeRequestError("Unarchive this chat before changing its queue.");
    return conversation;
  };
  const undelivered = (entry: { watcherNote?: WatcherNoteAttribution }, reason: string): void => {
    if (!entry.watcherNote) return;
    try {
      options.onWatcherNoteUndelivered?.(entry.watcherNote, reason);
    } catch {
    }
  };
  const block = (conversationId: string, entry: { id: string; watcherNote?: WatcherNoteAttribution }, reason: string): void => {
    store.queuedMessages.block(conversationId, entry.id, reason);
    undelivered(entry, reason);
  };
  const retryAfterCleanup = (conversationId: string, manualId?: string): void => {
    if (manualId) manualRetries.set(conversationId, manualId);
    void turns.waitForProviderCleanup([conversationId]).then(() => schedule(conversationId)).catch(() => undefined);
  };

  const waitingDelivery = (conversationId: string): (QueuedMessage & { delegatedCompletion: DelegatedCompletionAttribution }) | null => {
    const hooks = options.delegated?.();
    const entry = store.queuedMessages.activeDelegatedDelivery(conversationId);
    const attribution = entry?.delegatedCompletion;
    return hooks && entry && attribution && entry.state === "waiting" && hooks.automatic(conversationId, attribution)
      ? { ...entry, delegatedCompletion: attribution } : null;
  };
  const manualTarget = (conversationId: string, manualId: string | undefined): string | undefined => {
    if (manualId === undefined || store.queuedMessages.get(conversationId, manualId)?.delegatedCompletion) return manualId;
    return waitingDelivery(conversationId)?.id ?? manualId;
  };

  async function dispatch(conversationId: string, requestedId?: string): Promise<void> {
    if (options.signal.aborted || !dependencies.enableProviders || turns.isClosing()) return;
    const hooks = options.delegated?.();
    const manualId = manualTarget(conversationId, requestedId);
    const skipped = (entry: QueuedMessage): boolean => entry.id !== manualId && (entry.delegatedCompletion
      ? manualId !== undefined || entry.state === "blocked" || !hooks?.automatic(conversationId, entry.delegatedCompletion)
      : entry.watcherNote !== undefined && entry.state === "blocked");
    const first = store.queuedMessages.list(conversationId).find((entry) => !skipped(entry));
    const retry = manualRetries.get(conversationId);
    manualRetries.delete(conversationId);
    if (!first || (manualId && first.id !== manualId)) return;
    const manual = manualId ?? (retry === first.id && first.state === "waiting" ? retry : undefined);
    if (!manual && first.state !== "waiting") return;
    if (!await turns.waitForProviderCleanup([conversationId], Date.now() + 30_000)) {
      retryAfterCleanup(conversationId, manual);
      return;
    }
    if (options.signal.aborted || turns.isClosing() || turns.isActive(conversationId)) return;
    if (options.compacting?.(conversationId)) {
      if (manual) manualRetries.set(conversationId, manual);
      return;
    }
    const conversation = store.conversation(conversationId);
    if (store.orchestration.hasPendingCleanup(conversationId)) {
      if (manual) manualRetries.set(conversationId, manual);
      retryAfterAdmission(conversationId);
      return;
    }
    if (conversation.archivedAt !== null) return;
    if (!manual && !releasesQueue(store.latestAgentTurnForConversation(conversationId))) return;
    if (!store.queuedMessages.routeMatches(first, conversation)) {
      block(conversationId, first, "This chat's model, access or workspace changed. Remove and queue the message again.");
      changed(conversationId);
      return;
    }
    if (isHeld()) {
      retryAfterAdmission(conversationId);
      return;
    }
    if (store.conversationWork.restoreBlocksConversation(conversationId)) {
      if (manual) manualRetries.set(conversationId, manual);
      retryAfterAdmission(conversationId);
      return;
    }
    const attribution = first.delegatedCompletion;
    const content = attribution ? hooks?.content(attribution) ?? null : first.content;
    if (content === null) {
      if (store.queuedMessages.withdrawDelegatedDelivery(conversationId, first.id)) changed(conversationId);
      return;
    }
    if (!store.queuedMessages.claim(conversationId, first.id)) return;
    changed(conversationId);
    const handler = createTurnInteractionCommandHandler({
      ...dependencies, queuedMessage: first,
      ...(first.watcherNote ? { watcherDelivery: watcherNoteDelivery(first.watcherNote) } : {}),
      ...(attribution ? { delegatedDelivery: delegatedDelivery(attribution) } : {}),
      send: (_socket, _event) => undefined,
    });
    try {
      await handler(null as unknown as WebSocket, {
        type: "message.send", requestId: first.id,
        payload: { conversationId, content, attachments: [], activate: false },
      });
      const turnId = attribution ? store.queuedMessages.get(conversationId, first.id)?.turnId : null;
      if (attribution && turnId) hooks?.dispatched(attribution, turnId);
    } catch (error) {
      if (options.signal.aborted || turns.isClosing()) store.queuedMessages.release(conversationId, first.id);
      else if (transientDispatchFailure(error) && store.queuedMessages.release(conversationId, first.id)) retryAfterCleanup(conversationId, manualId);
      else block(conversationId, first, publicRuntimeError(error));
    } finally {
      changed(conversationId);
    }
  }

  const retryAfterAdmission = (conversationId: string): void => {
    if (options.signal.aborted || deferred.has(conversationId)) return;
    deferred.add(conversationId);
    setTimeout(() => {
      deferred.delete(conversationId);
      void schedule(conversationId).catch(() => undefined);
    }, ADMISSION_RETRY_MS).unref();
  };

  function schedule(conversationId: string): Promise<void> {
    if (options.signal.aborted || !dependencies.enableProviders) return Promise.resolve();
    if (recovering) {
      recovering.add(conversationId);
      return Promise.resolve();
    }
    again.add(conversationId);
    const previous = running.get(conversationId);
    if (previous) return previous;
    if (deferred.has(conversationId)) return Promise.resolve();
    let admitted = false;
    const task = options.track(async () => {
      admitted = true;
      while (again.delete(conversationId) && !options.signal.aborted) {
        await dispatch(conversationId).catch(() => undefined);
      }
    }).finally(() => {
      running.delete(conversationId);
      if (!admitted) retryAfterAdmission(conversationId);
      else if (again.has(conversationId)) void schedule(conversationId).catch(() => undefined);
    });
    running.set(conversationId, task);
    return task;
  }

  async function enqueue(input: { conversationId: string; id: string; content: string; attachments: ChatAttachment[] }, handoffId: string): Promise<void> {
    const previous = enqueueing.get(input.id);
    if (previous) {
      await previous;
      store.queuedMessages.replay(input.conversationId, input.id, queuedIntentDigest(input.content, input.attachments));
      return;
    }
    const operation = (async () => {
      const conversation = requireConversation(input.conversationId);
      const digest = queuedIntentDigest(input.content, input.attachments);
      if (store.queuedMessages.replay(conversation.id, input.id, digest)) return;
      if (!dependencies.enableProviders) throw new RuntimeRequestError("Message queues require an available provider runtime.");
      if (input.attachments.some(({ mimeType }) => chatAttachmentKind(mimeType) !== "image")) {
        throw new RuntimeRequestError("Queued messages support images only.");
      }
      const retentionId = randomUUID();
      const abort = new AbortController();
      const deadline = messageSendPreparationDeadline();
      let sourceIds: string[] = [];
      let retained = false;
      let persisted = false;
      try {
        const payloads = input.attachments.length > 0
          ? await awaitMessageSendPreparation(
            dependencies.attachmentResolver?.resolvePayloads(input.attachments, handoffId, abort.signal)
              ?? Promise.reject(new RuntimeRequestError("The selected image is no longer available.")),
            deadline, () => abort.abort(),
          ) : [];
        sourceIds = payloads.map(({ attachment }) => attachment.id);
        const retention = conversationAttachments.retain(payloads, abort.signal, retentionId, () => store.evictableAttachmentIds());
        let attachments: ChatAttachment[];
        try {
          attachments = await awaitMessageSendPreparation(retention, deadline, () => abort.abort());
          retained = true;
        } catch (error) {
          void retention.then(() => conversationAttachments.releaseRetention(retentionId), () => undefined).catch(() => undefined);
          throw error;
        }
        options.signal.throwIfAborted();
        const current = requireConversation(conversation.id);
        if (queuedRouteIdentity(current) !== queuedRouteIdentity(conversation)) {
          throw new RuntimeRequestError("The chat changed while preparing this queued message.");
        }
        store.queuedMessages.add({ ...input, conversation, attachments, digest });
        persisted = true;
        conversationAttachments.acceptRetention(retentionId);
        await dependencies.attachmentResolver?.releaseAll(sourceIds);
      } finally {
        if (!persisted) {
          if (retained) await conversationAttachments.releaseRetention(retentionId);
          await dependencies.attachmentResolver?.relinquishAll(sourceIds);
        }
      }
      changed(conversation.id);
    })();
    enqueueing.set(input.id, operation);
    try { await operation; } finally { enqueueing.delete(input.id); }
  }

  const undeliveredQueueFull = (): RuntimeRequestError => new RuntimeRequestError(
    "This follow-up did not reach the agent, and this chat already has three queued messages. Remove one and send it again.",
  );
  const assertRoomForUndelivered = (conversationId: string): void => {
    if (store.queuedMessages.cappedCount(conversationId) >= MAX_QUEUED_MESSAGES) throw undeliveredQueueFull();
  };
  const undeliveredFollowUps: NonNullable<TurnInteractionCommandDependencies["undeliveredFollowUps"]> = {
    async enqueue(input, handoffId) {
      assertRoomForUndelivered(input.conversationId);
      await enqueue(input, handoffId).catch((error: unknown) => {
        throw error instanceof QueuedMessageLimitError ? undeliveredQueueFull() : error;
      });
      void schedule(input.conversationId).catch(() => undefined);
      return result(input.conversationId, input.id);
    },
    adopt(input, unconfirmed) {
      const conversation = requireConversation(input.conversationId);
      assertRoomForUndelivered(conversation.id);
      try {
        store.queuedMessages.add({ ...input, conversation, digest: queuedIntentDigest(input.content, input.attachments) });
      } catch (error) {
        throw error instanceof QueuedMessageLimitError ? undeliveredQueueFull() : error;
      }
      if (unconfirmed) store.queuedMessages.block(conversation.id, input.id, unconfirmed);
      changed(conversation.id);
      void schedule(conversation.id).catch(() => undefined);
      return result(conversation.id, input.id);
    },
  };

  function enqueueWatcherNote(input: { conversationId: string; id: string; content: string; watcherNote: WatcherNoteAttribution }): MessageQueueResult {
    const conversation = requireConversation(input.conversationId);
    if (!dependencies.enableProviders) throw new RuntimeRequestError("Message queues require an available provider runtime.");
    const content = input.content.trim();
    if (!content) throw new RuntimeRequestError("The watcher note is empty.");
    const queueFull = () => new RuntimeRequestError("The main chat's queue is full. Send or remove a queued message, then try again.");
    if (input.watcherNote.automatic === true && store.queuedMessages.cappedCount(conversation.id) >= MAX_QUEUED_MESSAGES - 1) {
      throw queueFull();
    }
    try {
      store.queuedMessages.add({
        id: input.id, conversation, content, attachments: [],
        digest: queuedIntentDigest(content, []), watcherNote: input.watcherNote,
      });
    } catch (error) {
      throw error instanceof QueuedMessageLimitError ? queueFull() : error;
    }
    changed(conversation.id);
    void schedule(conversation.id).catch(() => undefined);
    return result(conversation.id, input.id);
  }

  function withdrawWatcherNote(conversationId: string, id: string): boolean {
    const entry = store.queuedMessages.get(conversationId, id);
    if (!entry?.watcherNote) return false;
    const removed = store.queuedMessages.cancel(conversationId, id);
    if (removed) changed(conversationId);
    return removed !== null;
  }

  async function stopAndSend(input: { conversationId: string; id: string; turnId: string; content: string; attachments: ChatAttachment[] }, handoffId: string): Promise<void> {
    const { conversationId, id, turnId } = input;
    requireConversation(conversationId);
    if (store.queuedMessages.list(conversationId).some((entry) => entry.id !== id && !entry.watcherNote && !entry.delegatedCompletion)) {
      throw new RuntimeRequestError("Send or remove the queued message first.");
    }
    await enqueue({ conversationId, id, content: input.content, attachments: input.attachments }, handoffId);
    const owner = turns.activeIdentity(conversationId);
    if (owner && !(owner.turnId === turnId && turns.cancelOwned(conversationId, owner))) {
      void schedule(conversationId).catch(() => undefined);
      return;
    }
    retryAfterCleanup(conversationId, id);
  }

  async function sendDuringTurn(conversationId: string, id: string): Promise<void> {
    const conversation = requireConversation(conversationId);
    if (store.queuedMessages.get(conversationId, id)?.delegatedCompletion) {
      throw new RuntimeRequestError("Delegated results continue this chat after the current turn ends.");
    }
    const first = store.queuedMessages.list(conversationId).find((entry) => !entry.delegatedCompletion);
    if (!first || first.id !== id) throw new RuntimeRequestError("Send the first queued message first.");
    if (first.state === "dispatching") return;
    if (!store.queuedMessages.routeMatches(first, conversation)) {
      block(conversationId, first, "This chat's model, access or workspace changed. Remove and queue the message again.");
      changed(conversationId);
      return;
    }
    const admission = turns.acquireFollowUpAdmission(conversationId);
    if (!admission) throw new RuntimeRequestError("This agent cannot take a message while it works. It will send when the turn ends.");
    let claimed = false;
    let acknowledged = false;
    try {
      if (first.attachments.length > 0 && !admission.supportsImages) {
        throw new RuntimeRequestError("The active model cannot inspect follow-up images. It will send when the turn ends.");
      }
      const deadline = messageSendPreparationDeadline();
      const attachments: ChatAttachment[] = [];
      for (const attachment of first.attachments) {
        const preview = await awaitMessageSendPreparation(conversationAttachments.resolve(attachment.id), deadline);
        if (!preview) throw new RuntimeRequestError("A queued image is no longer available. Remove this message and attach it again.");
        attachments.push({ ...preview.attachment, ...(attachment.snapshot ? { snapshot: attachment.snapshot } : {}) });
      }
      if (!store.queuedMessages.claim(conversationId, first.id)) return;
      claimed = true;
      changed(conversationId);
      const steered = await turns.steer(
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
      );
      if (steered.kind === "accepted") {
        claimed = false;
        dependencies.broadcast({ type: "conversation.message.persisted", message: steered.message });
        dependencies.broadcastSnapshot();
        return;
      }
      if (steered.kind === "unconfirmed") {
        claimed = false;
        block(conversationId, first, steered.message);
        return;
      }
      store.queuedMessages.release(conversationId, first.id);
      claimed = false;
      if (steered.kind === "turn-ended") void schedule(conversationId).catch(() => undefined);
      else throw new RuntimeRequestError("The agent did not take this message now. It will send when the turn ends.");
    } catch (error) {
      if (claimed) {
        if (acknowledged) {
          block(conversationId, first, "The agent received this message, but Inertia could not record it. Check the chat before sending it again.");
        } else if (error instanceof RuntimeRequestError && error.delivery === "ambiguous") {
          block(conversationId, first, publicRuntimeError(error));
        } else {
          store.queuedMessages.release(conversationId, first.id);
        }
      }
      throw error;
    } finally {
      admission.release();
      changed(conversationId);
    }
  }

  const handler = defineRuntimeCommandHandler([
    "message.queue.get", "message.queue.enqueue", "message.queue.remove", "message.queue.send", "message.queue.stop-and-send",
  ], async (socket, command) => {
    if (!command.type.startsWith("message.queue.")) return "not-handled";
    if (command.type !== "message.queue.get" && command.type !== "message.queue.enqueue" && command.type !== "message.queue.remove"
      && command.type !== "message.queue.send" && command.type !== "message.queue.stop-and-send") return "not-handled";
    const { conversationId } = command.payload;
    store.conversation(conversationId);
    if ((command.type === "message.queue.send" || command.type === "message.queue.stop-and-send") && isHeld()) {
      throw new RuntimeRequestError(UPDATE_HOLD_MESSAGE);
    }
    if ((command.type === "message.queue.send" || command.type === "message.queue.stop-and-send")
      && store.conversationWork.restoreBlocksConversation(conversationId)) {
      throw new RuntimeRequestError(CHECKOUT_RESTORE_IN_PROGRESS);
    }
    if (command.type === "message.queue.enqueue") {
      await enqueue(command.payload, command.requestId);
      void schedule(conversationId).catch(() => undefined);
    } else if (command.type === "message.queue.remove") {
      requireConversation(conversationId);
      const target = store.queuedMessages.get(conversationId, command.payload.id);
      const hooks = options.delegated?.();
      if (target?.delegatedCompletion && hooks) {
        await hooks.dismiss({ ...target, delegatedCompletion: target.delegatedCompletion }, command.requestId);
        if (store.queuedMessages.list(conversationId).some(({ id }) => id === target.id)) {
          throw new RuntimeRequestError("These delegated results have already been sent.");
        }
        changed(conversationId);
        void schedule(conversationId).catch(() => undefined);
        dependencies.send(socket, { type: "request.result", requestId: command.requestId, result: result(conversationId, target.id) });
        return "handled";
      }
      const removed = store.queuedMessages.cancel(conversationId, command.payload.id);
      if (!removed) throw new RuntimeRequestError("This queued message has already been dispatched.");
      undelivered(removed, WATCHER_NOTE_REMOVED_REASON);
      const candidates = removed.attachments.map(({ id }) => id);
      const referenced = store.referencedAttachmentIds(candidates);
      await conversationAttachments.release(candidates.filter((id) => !referenced.has(id)));
      changed(conversationId);
      void schedule(conversationId).catch(() => undefined);
    } else if (command.type === "message.queue.send") {
      requireConversation(conversationId);
      await running.get(conversationId);
      if (turns.isActive(conversationId)) await sendDuringTurn(conversationId, command.payload.id);
      else await dispatch(conversationId, command.payload.id);
    } else if (command.type === "message.queue.stop-and-send") {
      await stopAndSend(command.payload, command.requestId);
    }
    const event: ServerEvent = { type: "request.result", requestId: command.requestId,
      result: result(conversationId, command.payload.id) };
    dependencies.send(socket, event);
    return "handled";
  });
  async function steerDelegated(conversationId: string): Promise<boolean> {
    const hooks = options.delegated?.();
    const entry = store.queuedMessages.activeDelegatedDelivery(conversationId);
    const attribution = entry?.delegatedCompletion;
    if (!hooks || !entry || !attribution || entry.state !== "waiting" || !hooks.automatic(conversationId, attribution)
      || !hooks.steerable(conversationId, attribution)) return false;
    const content = hooks.content(attribution);
    if (content === null) return false;
    const admission = turns.acquireFollowUpAdmission(conversationId);
    if (!admission) return false;
    let claimed = false;
    try {
      if (!store.queuedMessages.claim(conversationId, entry.id)) return false;
      claimed = true;
      changed(conversationId);
      const steered = await turns.steer(admission, { content, imagePaths: [] }, [], undefined,
        AbortSignal.timeout(Math.max(0, messageSendPreparationDeadline() - Date.now())),
        { queuedMessageId: entry.id, providerContent: delegatedSteerContent(content), delegatedCompletion: attribution });
      claimed = false;
      if (steered.kind === "accepted") {
        hooks.steered(attribution, admission.turnId);
        dependencies.broadcast({ type: "conversation.message.persisted", message: steered.message });
        dependencies.broadcastSnapshot();
        return true;
      }
      store.queuedMessages.release(conversationId, entry.id);
      void schedule(conversationId).catch(() => undefined);
      return false;
    } catch {
      if (claimed) store.queuedMessages.release(conversationId, entry.id);
      void schedule(conversationId).catch(() => undefined);
      return false;
    } finally {
      admission.release();
      changed(conversationId);
    }
  }

  async function queueBehindDelivery(socket: WebSocket,
    command: Extract<ClientCommand, { type: "message.send" }>): Promise<boolean> {
    const { conversationId, content, attachments, context } = command.payload;
    if (!dependencies.enableProviders || isHeld() || context !== undefined || turns.isActive(conversationId)) return false;
    const delivery = waitingDelivery(conversationId);
    if (!delivery || attachments.some(({ mimeType }) => chatAttachmentKind(mimeType) !== "image")) return false;
    if (!store.queuedMessages.get(conversationId, command.requestId)
      && store.queuedMessages.cappedCount(conversationId) >= MAX_QUEUED_MESSAGES) {
      throw new RuntimeRequestError("Delegated results continue this chat first, and its queue is full. Remove a queued message and send again.");
    }
    await enqueue({ conversationId, id: command.requestId, content, attachments }, command.requestId);
    await running.get(conversationId);
    await dispatch(conversationId, delivery.id);
    dependencies.send(socket, { type: "request.result", requestId: command.requestId, result: result(conversationId, command.requestId) });
    return true;
  }

  const directTurnInteraction = createTurnInteractionCommandHandler({ ...dependencies, undeliveredFollowUps });
  const turnInteractionHandler = defineRuntimeCommandHandler(directTurnInteraction.commandTypes ?? [],
    async (socket, command, authority) => {
      if (command.type === "message.send" && await queueBehindDelivery(socket, command)) return "handled";
      return await directTurnInteraction(socket, command, authority);
    });

  return {
    handler,
    turnInteractionHandler,
    async offerDelegated(conversationId: string): Promise<void> {
      if (turns.isActive(conversationId)) {
        await steerDelegated(conversationId);
        return;
      }
      await schedule(conversationId);
    },
    async sendDelegated(conversationId: string): Promise<void> {
      await running.get(conversationId);
      const entry = store.queuedMessages.activeDelegatedDelivery(conversationId);
      if (!entry) throw new RuntimeRequestError("No delegated results are waiting to be sent.");
      if (turns.isActive(conversationId)) return;
      await dispatch(conversationId, entry.id);
    },
    enqueueWatcherNote,
    withdrawWatcherNote,
    onTurnSettled(turn: AgentTurn): void { if (releasesQueue(turn)) void schedule(turn.conversationId).catch(() => undefined); },
    onCompactionSettled(conversationId: string): void {
      if (store.queuedMessages.list(conversationId).length > 0) void schedule(conversationId).catch(() => undefined);
    },
    async start(beforeSchedule?: () => void | Promise<void>): Promise<void> {
      store.queuedMessages.reconcile();
      const held = new Set<string>();
      recovering = held;
      try {
        await beforeSchedule?.();
      } finally {
        recovering = null;
      }
      const pending = new Set([...store.queuedMessages.pendingConversationIds(), ...held]);
      for (const conversationId of pending) void schedule(conversationId).catch(() => undefined);
    },
  };
}
