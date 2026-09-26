import type WebSocket from "ws";
import type { ServerEvent } from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import { MessageQueueError } from "../../persistence/message-queue-repository";
import { RuntimeRequestError } from "../../runtime-errors";
import type { MessageQueueController } from "../message-queue-controller";
import { defineRuntimeCommandHandler } from "./command-router";

export function createMessageQueueCommandHandler(dependencies: {
  store: RuntimeStore; queue: MessageQueueController;
  changed(conversationId: string): void;
  send(socket: WebSocket, event: ServerEvent): void;
}) {
  return defineRuntimeCommandHandler(["message.queue"], async (socket, command) => {
    if (command.type !== "message.queue") return "not-handled";
    const input = command.payload;
    const conversation = dependencies.store.conversation(input.conversationId);
    if (conversation.archivedAt && input.action !== "list" && input.action !== "remove") throw new RuntimeRequestError("Unarchive this chat before changing its queued work.");
    const repository = dependencies.store.messageQueue;
    try {
      switch (input.action) {
        case "list": break;
        case "enqueue": {
          const latest = dependencies.store.latestAgentTurnForConversation(conversation.id);
          repository.enqueue({ ...input, afterTurnId: latest?.id ?? null });
          break;
        }
        case "remove": repository.remove(conversation.id, input.id); break;
        case "pause": repository.pause(conversation.id, input.id, input.paused); break;
        case "move": repository.move(conversation.id, input.id, input.direction); break;
        case "send": await dependencies.queue.send(conversation.id, input.id); break;
      }
    } catch (error) {
      if (error instanceof MessageQueueError) throw new RuntimeRequestError(error.message);
      throw error;
    }
    if (input.action !== "list") {
      dependencies.changed(conversation.id);
      dependencies.queue.kick(conversation.id);
    }
    dependencies.send(socket, { type: "request.result", requestId: command.requestId,
      result: { kind: "message.queue", conversationId: conversation.id, items: repository.list(conversation.id) } });
    return "handled";
  });
}
