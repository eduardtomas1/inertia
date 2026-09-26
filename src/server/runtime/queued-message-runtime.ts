import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import type { AgentTurn, ChatAttachment, ServerEvent } from "../../shared/contracts";
import { chatAttachmentKind } from "../../shared/attachments";
import type { MessageQueueResult } from "../../shared/queued-messages";
import { queuedIntentDigest, queuedRouteIdentity } from "../persistence/queued-message-repository";
import { publicRuntimeError, RuntimeRequestError } from "../runtime-errors";
import { defineRuntimeCommandHandler } from "./commands/command-router";
import { createTurnInteractionCommandHandler, type TurnInteractionCommandDependencies } from "./commands/turn-interaction-commands";
import { awaitMessageSendPreparation, messageSendPreparationDeadline } from "./commands/message-send-preparation";

/** Durable queue dispatch never depends on a renderer remaining mounted. */
export function createQueuedMessageRuntime(
  dependencies: TurnInteractionCommandDependencies,
  options: { signal: AbortSignal; track<T>(operation: () => Promise<T>): Promise<T> },
) {
  const { store, turns, conversationAttachments } = dependencies;
  const running = new Map<string, Promise<void>>();
  const enqueueing = new Map<string, Promise<void>>();
  const again = new Set<string>();
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

  async function dispatch(conversationId: string, manualId?: string): Promise<void> {
    if (options.signal.aborted || !dependencies.enableProviders || turns.isClosing()) return;
    const first = store.queuedMessages.list(conversationId)[0];
    if (!first || (manualId && first.id !== manualId)) return;
    if (!manualId && first.state !== "waiting") return;
    await turns.waitForProviderCleanup([conversationId], Date.now() + 30_000);
    if (options.signal.aborted || turns.isClosing() || turns.isActive(conversationId)) return;
    const conversation = store.conversation(conversationId);
    if (conversation.archivedAt !== null) return;
    if (!manualId && store.latestAgentTurnForConversation(conversationId)?.status !== "completed") return;
    if (!store.queuedMessages.routeMatches(first, conversation)) {
      store.queuedMessages.block(conversationId, first.id, "This chat's model, access or workspace changed. Remove and queue the message again.");
      changed(conversationId);
      return;
    }
    if (!store.queuedMessages.claim(conversationId, first.id)) return;
    changed(conversationId);
    // The private handler option is the only route to durable attachment
    // previews and the atomic receipt. Renderer payloads cannot select it.
    const handler = createTurnInteractionCommandHandler({
      ...dependencies, queuedMessage: first,
      send: (_socket, _event) => undefined,
    });
    try {
      await handler(null as unknown as WebSocket, {
        type: "message.send", requestId: first.id,
        payload: { conversationId, content: first.content, attachments: [], activate: false },
      });
    } catch (error) {
      // An accepted row is authoritative even when publication subsequently
      // failed. Never turn an uncertain acknowledgement into a second turn.
      store.queuedMessages.block(conversationId, first.id, publicRuntimeError(error));
    } finally {
      changed(conversationId);
    }
  }

  function schedule(conversationId: string): Promise<void> {
    if (options.signal.aborted || !dependencies.enableProviders) return Promise.resolve();
    again.add(conversationId);
    const previous = running.get(conversationId);
    if (previous) return previous;
    const task = options.track(async () => {
      while (again.delete(conversationId) && !options.signal.aborted) {
        try { await dispatch(conversationId); } catch { /* Deleted chats have no queue to dispatch. */ }
      }
    }).finally(() => { running.delete(conversationId); });
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

  const handler = defineRuntimeCommandHandler([
    "message.queue.get", "message.queue.enqueue", "message.queue.remove", "message.queue.send",
  ], async (socket, command) => {
    if (!command.type.startsWith("message.queue.")) return "not-handled";
    if (command.type !== "message.queue.get" && command.type !== "message.queue.enqueue"
      && command.type !== "message.queue.remove" && command.type !== "message.queue.send") return "not-handled";
    const { conversationId } = command.payload;
    store.conversation(conversationId);
    if (command.type === "message.queue.enqueue") {
      await enqueue(command.payload, command.requestId);
      void schedule(conversationId).catch(() => undefined);
    } else if (command.type === "message.queue.remove") {
      requireConversation(conversationId);
      const removed = store.queuedMessages.cancel(conversationId, command.payload.id);
      if (!removed) throw new RuntimeRequestError("This queued message has already been dispatched.");
      const candidates = removed.attachments.map(({ id }) => id);
      const referenced = store.referencedAttachmentIds(candidates);
      await conversationAttachments.release(candidates.filter((id) => !referenced.has(id)));
      changed(conversationId);
      void schedule(conversationId).catch(() => undefined);
    } else if (command.type === "message.queue.send") {
      requireConversation(conversationId);
      await running.get(conversationId);
      await dispatch(conversationId, command.payload.id);
    }
    const event: ServerEvent = { type: "request.result", requestId: command.requestId,
      result: result(conversationId, command.payload.id) };
    dependencies.send(socket, event);
    return "handled";
  });
  return {
    handler,
    onTurnSettled(turn: AgentTurn): void { if (turn.status === "completed") void schedule(turn.conversationId).catch(() => undefined); },
    start(): void {
      store.queuedMessages.reconcile();
      for (const conversationId of store.queuedMessages.pendingConversationIds()) void schedule(conversationId).catch(() => undefined);
    },
  };
}
