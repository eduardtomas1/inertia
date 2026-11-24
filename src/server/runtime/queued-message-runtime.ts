import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import type { AgentTurn, ChatAttachment, ServerEvent } from "../../shared/contracts";
import { chatAttachmentKind } from "../../shared/attachments";
import { MAX_QUEUED_MESSAGES, QUEUED_ROUTE_CHANGED_ERROR, type MessageQueueResult, type QueuedAccess, type QueuedMessage } from "../../shared/queued-messages";
import { effectiveAccessMode } from "../../shared/access-modes";
import { QueuedMessageLimitError, queuedIntentDigest, queuedRouteIdentity, releasesQueue } from "../persistence/queued-message-repository";
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
export const QUEUED_EDIT_GRANT_MS = 120_000;
export const QUEUED_DOCUMENTS_WAIT_FOR_TURN_END = "The agent can't take documents while it works. This message will send when the turn ends.";
const ACCESS_RANK = { supervised: 0, "auto-edit": 1, full: 2 } as const;
const INTERACTION_RANK = { plan: 0, build: 1 } as const;
const MAX_EDIT_GRANTS = 16;

const transientDispatchFailure = (error: unknown): boolean => error instanceof MessageSendPreparationTimeoutError
  || (error instanceof RuntimeRequestError && error.code === MESSAGE_ADMISSION_UNAVAILABLE);

interface QueuedMessageRuntimeOptions {
  signal: AbortSignal;
  track<T>(operation: () => Promise<T>): Promise<T>;
  onWatcherNoteUndelivered?(note: WatcherNoteAttribution, reason: string): void;
  compacting?(conversationId: string): boolean;
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
    }
  };
  const block = (conversationId: string, entry: { id: string; watcherNote?: WatcherNoteAttribution }, reason: string): void => {
    store.queuedMessages.block(conversationId, entry.id, reason);
    undelivered(entry, reason);
  };
  const routeChanged = (conversationId: string, entry: QueuedMessage): boolean => {
    try {
      return !store.queuedMessages.routeMatches(entry, store.conversation(conversationId));
    } catch {
      return false;
    }
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
    if (options.compacting?.(conversationId)) {
      if (manual) manualRetries.set(conversationId, manual);
      return;
    }
    const conversation = store.conversation(conversationId);
    if (conversation.archivedAt !== null) return;
    if (!manual && !releasesQueue(store.latestAgentTurnForConversation(conversationId))) return;
    if (!store.queuedMessages.routeMatches(first, conversation)) {
      block(conversationId, first, QUEUED_ROUTE_CHANGED_ERROR);
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
      else block(conversationId, first, routeChanged(conversationId, first) ? QUEUED_ROUTE_CHANGED_ERROR : publicRuntimeError(error));
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
              ?? Promise.reject(new RuntimeRequestError("The selected attachment is no longer available.")),
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

  /**
   * Queues a message a parent chat sent its managed child with mode `queue`.
   * It is an ordinary queued message: the user sees it in the child's queue
   * and can remove it, and the queue sends it after the current turn
   * completes. A full queue throws QueuedMessageLimitError.
   */
  function enqueueManagedMessage(input: { conversationId: string; id: string; content: string }): MessageQueueResult {
    const conversation = requireConversation(input.conversationId);
    if (!dependencies.enableProviders) throw new RuntimeRequestError("Message queues require an available provider runtime.");
    const content = input.content.trim();
    if (!content) throw new RuntimeRequestError("The queued message is empty.");
    store.queuedMessages.add({ id: input.id, conversation, content, attachments: [], digest: queuedIntentDigest(content, []) });
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
    if (store.queuedMessages.list(conversationId).some((entry) => entry.id !== id && !entry.watcherNote)) {
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
      block(conversationId, first, QUEUED_ROUTE_CHANGED_ERROR);
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
    try {
      if (first.attachments.length > 0 && !admission.supportsImages) {
        throw new RuntimeRequestError("The active model cannot inspect follow-up images. It will send when the turn ends.");
      }
      const deadline = messageSendPreparationDeadline();
      const attachments: ChatAttachment[] = [];
      for (const attachment of first.attachments) {
        const preview = await awaitMessageSendPreparation(conversationAttachments.resolve(attachment.id), deadline);
        if (!preview) throw new RuntimeRequestError("A queued image is no longer available. Remove this message and attach it again.");
        attachments.push({ ...preview.attachment, ...(attachment.snapshot ? { snapshot: attachment.snapshot } : {}), ...(attachment.previewAnnotation ? { previewAnnotation: attachment.previewAnnotation } : {}) });
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

  const editGrants = new Map<string, { conversationId: string; attachmentIds: string[]; timer: ReturnType<typeof setTimeout> }>();
  const releaseEditGrant = async (id: string): Promise<void> => {
    const grant = editGrants.get(id);
    if (!grant) return;
    editGrants.delete(id);
    clearTimeout(grant.timer);
    const referenced = store.referencedAttachmentIds(grant.attachmentIds);
    await conversationAttachments.release(grant.attachmentIds.filter((attachmentId) => !referenced.has(attachmentId)));
  };
  options.signal.addEventListener("abort", () => {
    for (const grant of editGrants.values()) clearTimeout(grant.timer);
    editGrants.clear();
  }, { once: true });

  function edit(conversationId: string, id: string): QueuedMessage {
    requireConversation(conversationId);
    if (store.queuedMessages.get(conversationId, id)?.watcherNote) {
      throw new RuntimeRequestError("A watcher note can't be edited. Remove it instead.");
    }
    const removed = store.queuedMessages.cancel(conversationId, id);
    if (!removed) throw new RuntimeRequestError("This queued message is already being sent.");
    if (removed.attachments.length > 0) {
      for (const oldest of editGrants.keys()) {
        if (editGrants.size < MAX_EDIT_GRANTS) break;
        void releaseEditGrant(oldest).catch(() => undefined);
      }
      const timer = setTimeout(() => { void releaseEditGrant(id).catch(() => undefined); }, QUEUED_EDIT_GRANT_MS);
      timer.unref?.();
      editGrants.set(id, { conversationId, attachmentIds: removed.attachments.map(({ id: attachmentId }) => attachmentId), timer });
    }
    changed(conversationId);
    void schedule(conversationId).catch(() => undefined);
    return removed;
  }

  function editedAttachmentConversations(attachmentId: string): string[] {
    const owners: string[] = [];
    for (const [grantId, grant] of editGrants.entries()) {
      if (!grant.attachmentIds.includes(attachmentId)) continue;
      try {
        store.conversation(grant.conversationId);
      } catch {
        void releaseEditGrant(grantId).catch(() => undefined);
        continue;
      }
      owners.push(grant.conversationId);
    }
    return [...new Set(owners)];
  }

  async function reconfirm(conversationId: string, id: string, confirmed: QueuedAccess | undefined): Promise<MessageQueueResult["confirmation"]> {
    const conversation = requireConversation(conversationId);
    const entry = store.queuedMessages.get(conversationId, id);
    if (!entry || (entry.state !== "waiting" && entry.state !== "blocked")) {
      throw new RuntimeRequestError("This queued message has already been dispatched.");
    }
    const routeBlocked = entry.state === "blocked"
      ? entry.error === QUEUED_ROUTE_CHANGED_ERROR
      : !store.queuedMessages.routeMatches(entry, conversation);
    if (!routeBlocked) throw new RuntimeRequestError("This queued message is not waiting on a settings change.");
    const queued = store.queuedMessages.queuedRoute(conversationId, id);
    if (!queued) throw new RuntimeRequestError("This queued message's original settings can't be read. Edit or remove it.");
    const current: QueuedAccess = { interactionMode: conversation.interactionMode, accessMode: conversation.accessMode };
    const widens = ACCESS_RANK[effectiveAccessMode(conversation.providerId, conversation.accessMode)]
        > ACCESS_RANK[effectiveAccessMode(queued.providerId, queued.accessMode)]
      || INTERACTION_RANK[conversation.interactionMode] > INTERACTION_RANK[queued.interactionMode];
    if (widens && (confirmed?.accessMode !== current.accessMode || confirmed.interactionMode !== current.interactionMode)) {
      return { id, queued: { interactionMode: queued.interactionMode, accessMode: queued.accessMode }, current };
    }
    if (!store.queuedMessages.reroute(conversation, id)) throw new RuntimeRequestError("This queued message has already been dispatched.");
    changed(conversationId);
    if (turns.isActive(conversationId)) {
      void schedule(conversationId).catch(() => undefined);
      return undefined;
    }
    await running.get(conversationId);
    await dispatch(conversationId, id);
    return undefined;
  }

  const handler = defineRuntimeCommandHandler([
    "message.queue.get", "message.queue.enqueue", "message.queue.remove", "message.queue.send", "message.queue.stop-and-send",
    "message.queue.edit", "message.queue.reconfirm",
  ], async (socket, command) => {
    if (!command.type.startsWith("message.queue.")) return "not-handled";
    if (command.type !== "message.queue.get" && command.type !== "message.queue.enqueue" && command.type !== "message.queue.remove"
      && command.type !== "message.queue.send" && command.type !== "message.queue.stop-and-send"
      && command.type !== "message.queue.edit" && command.type !== "message.queue.reconfirm") return "not-handled";
    const { conversationId } = command.payload;
    store.conversation(conversationId);
    if ((command.type === "message.queue.send" || command.type === "message.queue.stop-and-send" || command.type === "message.queue.reconfirm") && isHeld()) {
      throw new RuntimeRequestError(UPDATE_HOLD_MESSAGE);
    }
    if (command.type === "message.queue.edit") {
      const edited = edit(conversationId, command.payload.id);
      dependencies.send(socket, { type: "request.result", requestId: command.requestId,
        result: { ...result(conversationId, command.payload.id), edited } });
      return "handled";
    }
    if (command.type === "message.queue.reconfirm") {
      const confirmation = await reconfirm(conversationId, command.payload.id, command.payload.confirmed);
      dependencies.send(socket, { type: "request.result", requestId: command.requestId,
        result: { ...result(conversationId, command.payload.id), ...(confirmation ? { confirmation } : {}) } });
      return "handled";
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
    enqueueManagedMessage,
    withdrawWatcherNote,
    editedAttachmentConversations,
    onTurnSettled(turn: AgentTurn): void { if (releasesQueue(turn)) void schedule(turn.conversationId).catch(() => undefined); },
    onCompactionSettled(conversationId: string): void {
      if (store.queuedMessages.list(conversationId).length > 0) void schedule(conversationId).catch(() => undefined);
    },
    start(): void {
      store.queuedMessages.reconcile();
      for (const conversationId of store.queuedMessages.pendingConversationIds()) void schedule(conversationId).catch(() => undefined);
    },
  };
}
