import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import type { AgentTurn, ChatAttachment, ServerEvent } from "../../shared/contracts";
import { chatAttachmentKind } from "../../shared/attachments";
import { MAX_QUEUED_MESSAGES, type MessageQueueResult } from "../../shared/queued-messages";
import { QueuedMessageLimitError, queuedIntentDigest, queuedRouteIdentity } from "../persistence/queued-message-repository";
import { MESSAGE_ADMISSION_UNAVAILABLE, publicRuntimeError, RuntimeRequestError } from "../runtime-errors";
import { defineRuntimeCommandHandler } from "./commands/command-router";
import { createTurnInteractionCommandHandler, type TurnInteractionCommandDependencies } from "./commands/turn-interaction-commands";
import {
  awaitMessageSendPreparation, MessageSendPreparationTimeoutError, messageSendPreparationDeadline,
} from "./commands/message-send-preparation";
import { isHeld, UPDATE_HOLD_MESSAGE } from "./update-hold";
import type { WatcherNoteAttribution } from "../../shared/watcher";
import { watcherNoteDelivery, watcherSteerContent } from "./watcher/watcher-note-instruction";

const ADMISSION_RETRY_MS = 1_000;

function releasesQueue(turn: Pick<AgentTurn, "status" | "terminalReason"> | null): boolean {
  return turn?.status === "completed" || (turn?.status === "interrupted" && turn.terminalReason === "app-update");
}

const transientDispatchFailure = (error: unknown): boolean => error instanceof MessageSendPreparationTimeoutError
  || (error instanceof RuntimeRequestError && error.code === MESSAGE_ADMISSION_UNAVAILABLE);

export interface QueuedMessageRuntimeOptions {
  signal: AbortSignal;
  track<T>(operation: () => Promise<T>): Promise<T>;
  /** A queued watcher note was removed or blocked, so it will not be sent as queued. */
  onWatcherNoteUndelivered?(note: WatcherNoteAttribution, reason: string): void;
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
      // Watcher bookkeeping never interrupts the queue.
    }
  };
  /** Blocks a queue entry; a blocked watcher note marks its finding as not sent. */
  const block = (conversationId: string, entry: { id: string; watcherNote?: WatcherNoteAttribution }, reason: string): void => {
    store.queuedMessages.block(conversationId, entry.id, reason);
    undelivered(entry, reason);
  };
  const retryAfterCleanup = (conversationId: string, manualId?: string): void => {
    if (manualId) manualRetries.set(conversationId, manualId);
    void turns.waitForProviderCleanup([conversationId]).then(() => schedule(conversationId)).catch(() => undefined);
  };

  async function dispatch(conversationId: string, manualId?: string): Promise<void> {
    if (options.signal.aborted || !dependencies.enableProviders || turns.isClosing()) return;
    const first = store.queuedMessages.list(conversationId)
      .find((entry) => entry.id === manualId || entry.state !== "blocked" || !entry.watcherNote);
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
    const conversation = store.conversation(conversationId);
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
    if (!store.queuedMessages.claim(conversationId, first.id)) return;
    changed(conversationId);
    const handler = createTurnInteractionCommandHandler({
      ...dependencies, queuedMessage: first,
      ...(first.watcherNote ? { watcherDelivery: watcherNoteDelivery(first.watcherNote) } : {}),
      send: (_socket, _event) => undefined,
    });
    try {
      await handler(null as unknown as WebSocket, {
        type: "message.send", requestId: first.id,
        payload: { conversationId, content: first.content, attachments: [], activate: false },
      });
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
    if (store.queuedMessages.list(conversationId).length >= MAX_QUEUED_MESSAGES) throw undeliveredQueueFull();
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

  /**
   * Queues a watcher note the user chose to forward. It waits behind every
   * user-authored queued message and shares the chat's queue limit.
   */
  function enqueueWatcherNote(input: { conversationId: string; id: string; content: string; watcherNote: WatcherNoteAttribution }): MessageQueueResult {
    const conversation = requireConversation(input.conversationId);
    if (!dependencies.enableProviders) throw new RuntimeRequestError("Message queues require an available provider runtime.");
    const content = input.content.trim();
    if (!content) throw new RuntimeRequestError("The watcher note is empty.");
    const queueFull = () => new RuntimeRequestError("The main chat's queue is full. Send or remove a queued message, then try again.");
    if (input.watcherNote.automatic === true && store.queuedMessages.list(conversation.id).length >= MAX_QUEUED_MESSAGES - 1) {
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

  /** Withdraws a waiting or blocked watcher note, for example before its finding is sent again. */
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
    if (store.queuedMessages.list(conversationId).some((entry) => entry.id !== id)) {
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
    const first = store.queuedMessages.list(conversationId)[0];
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
    if (command.type === "message.queue.enqueue") {
      await enqueue(command.payload, command.requestId);
      void schedule(conversationId).catch(() => undefined);
    } else if (command.type === "message.queue.remove") {
      requireConversation(conversationId);
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
  return {
    handler,
    turnInteractionHandler: createTurnInteractionCommandHandler({ ...dependencies, undeliveredFollowUps }),
    enqueueWatcherNote,
    withdrawWatcherNote,
    onTurnSettled(turn: AgentTurn): void { if (releasesQueue(turn)) void schedule(turn.conversationId).catch(() => undefined); },
    start(): void {
      store.queuedMessages.reconcile();
      for (const conversationId of store.queuedMessages.pendingConversationIds()) void schedule(conversationId).catch(() => undefined);
    },
  };
}
