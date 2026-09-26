import type WebSocket from "ws";
import { RuntimeRequestError } from "../runtime-errors";
import { createTurnInteractionCommandHandler, type TurnInteractionCommandDependencies } from "./commands/turn-interaction-commands";
import { createMessageQueueCommandHandler } from "./commands/message-queue-commands";
import { MessageQueueController } from "./message-queue-controller";
import { withMessageSendReceipts } from "./commands/message-send-receipts";

export function createMessageQueueRuntime(
  dependencies: TurnInteractionCommandDependencies,
  lifecycle: { canDispatch(): boolean; track(operation: () => Promise<void>): Promise<void> },
) {
  const changed = (conversationId: string): void => {
    dependencies.broadcast({ type: "conversation.detail.invalidated", conversationId });
  };
  const durableHandler = (send: TurnInteractionCommandDependencies["send"]) => withMessageSendReceipts(
    dependencies.store.messageSendReceipts,
    (publish) => createTurnInteractionCommandHandler({ ...dependencies, send: (_socket, event) => publish(event) }),
    send,
  );
  const queue = new MessageQueueController({
    store: dependencies.store,
    isActive: (conversationId) => dependencies.turns.isActive(conversationId)
      || dependencies.isolatedRuns.has(conversationId)
      || dependencies.providerTerminalResumes.isActive(conversationId),
    canDispatch: () => dependencies.enableProviders && lifecycle.canDispatch(),
    changed,
    track: (operation) => { void lifecycle.track(() => operation).catch(() => undefined); },
    dispatch: async (message, accepted) => {
      let acknowledged = false;
      const handler = durableHandler(
        // The local worker captures the command response. No renderer socket is used.
        (_socket, event) => {
          if (event.type === "request.result" && event.result.kind === "message.accepted") {
            acknowledged = true;
            accepted(event.result);
          }
        },
      );
      try {
        await handler(Object.create(null) as WebSocket, {
          type: "message.send", requestId: message.id,
          payload: { conversationId: message.conversationId, content: message.content, attachments: [], activate: false },
        });
        if (!acknowledged) throw new RuntimeRequestError("Queued delivery could not be confirmed. Check this chat before sending new work.", undefined, "ambiguous");
      } catch (error) {
        if (acknowledged) throw new RuntimeRequestError("Queued work was accepted but its acknowledgement could not finish.", undefined, "ambiguous");
        throw error;
      }
    },
  });
  return {
    queue,
    turnCommands: durableHandler(dependencies.send),
    queueCommands: createMessageQueueCommandHandler({ store: dependencies.store, queue, changed, send: dependencies.send }),
  };
}
