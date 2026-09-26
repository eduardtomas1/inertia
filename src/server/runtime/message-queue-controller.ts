import type { AgentTurn, MessageSendAcceptance } from "../../shared/contracts";
import type { QueuedMessage } from "../../shared/message-queue";
import type { RuntimeStore } from "../database";
import { publicRuntimeError, RuntimeRequestError } from "../runtime-errors";

interface QueueDependencies {
  store: RuntimeStore;
  isActive(conversationId: string): boolean;
  canDispatch(): boolean;
  dispatch(message: QueuedMessage, accepted: (receipt: MessageSendAcceptance) => void): Promise<void>;
  changed(conversationId: string): void;
  track(operation: Promise<void>): void;
}

/** A dispatch intent is durable before preparation; unknown delivery never retries itself. */
export class MessageQueueController {
  private readonly dispatches = new Map<string, Promise<void>>();
  constructor(private readonly dependencies: QueueDependencies) {}

  kick(conversationId: string): void {
    if (!this.dependencies.canDispatch() || this.dispatches.has(conversationId)
      || this.dependencies.isActive(conversationId)) return;
    try {
      if (this.dependencies.store.conversation(conversationId).archivedAt) return;
    } catch { return; } // Deletion may complete while a tracked dispatch settles.
    const first = this.dependencies.store.messageQueue.list(conversationId)[0];
    if (!first || first.status !== "queued") return;
    const latest = this.dependencies.store.latestAgentTurnForConversation(conversationId);
    if (latest && (latest.id !== first.afterTurnId || latest.status !== "completed")) return;
    if (!latest && first.afterTurnId !== null) return;
    this.dependencies.track(this.send(conversationId, first.id, false));
  }

  start(): void {
    let conversations: string[];
    try { conversations = this.dependencies.store.messageQueue.conversationIds(); }
    catch { return; } // Queue recovery failure must not fail provider discovery.
    for (const conversationId of conversations) {
      try {
        for (const message of this.dependencies.store.messageQueue.list(conversationId)) {
          if (message.status !== "uncertain") continue;
          try {
            const receipt = this.dependencies.store.messageSendReceipts.accepted(message.id, conversationId);
            if (receipt) this.dependencies.store.messageQueue.accept(message.id, receipt, true);
          } catch { /* Preserve uncertainty; another chat's queue can still start. */ }
        }
        this.kick(conversationId);
      } catch { /* Isolate a damaged chat from independent queues. */ }
    }
  }

  onTurnSettled(turn: AgentTurn): void {
    if (turn.status === "completed") this.kick(turn.conversationId);
  }

  send(conversationId: string, id: string, manual = true): Promise<void> {
    const current = this.dispatches.get(conversationId);
    if (current) return current;
    if (!this.dependencies.canDispatch()) return Promise.reject(new RuntimeRequestError("The runtime cannot dispatch queued work right now."));
    const message = this.dependencies.store.messageQueue.claim(conversationId, id, manual);
    if (!message) return Promise.resolve();
    // Defer the callback so the conversation lock exists even for synchronous failures.
    const task = Promise.resolve().then(async () => {
      try {
        this.dependencies.changed(conversationId);
        if (!this.dependencies.canDispatch()) throw new RuntimeRequestError("The runtime stopped before queued work began.");
        await this.dependencies.dispatch(message, (receipt) => {
          this.dependencies.store.messageQueue.accept(id, receipt);
          this.dependencies.changed(conversationId);
        });
      } catch (error) {
        this.dependencies.store.messageQueue.fail(id,
          !(error instanceof RuntimeRequestError) || error.delivery === "ambiguous",
          publicRuntimeError(error));
      } finally {
        this.dependencies.changed(conversationId);
      }
    }).finally(() => {
      if (this.dispatches.get(conversationId) === task) this.dispatches.delete(conversationId);
      this.kick(conversationId);
    });
    this.dispatches.set(conversationId, task);
    return task;
  }
}
