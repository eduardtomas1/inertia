import { RuntimeRequestError } from "../../runtime-errors";
import { defineRuntimeCommandHandler, type RuntimeCommandHandler } from "./command-router";
import type { UsageCommandDependencies } from "./usage-commands";

export const ACTIVITY_DETAIL_UNAVAILABLE_MESSAGE = "That output is no longer available in this chat.";

export function createConversationReadCommandHandler(
  dependencies: UsageCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler(["conversation.archived.list", "activity.detail.read"], async (socket, command) => {
    if (command.type === "conversation.archived.list") {
      dependencies.send(socket, {
        type: "request.result",
        requestId: command.requestId,
        result: dependencies.store.archivedConversations(command.payload),
      });
      return "handled";
    }
    if (command.type !== "activity.detail.read") return "not-handled";
    const { conversationId, activityId } = command.payload;
    const result = dependencies.store.activityDetail(conversationId, activityId);
    if (!result || result.conversationId !== conversationId || result.activityId !== activityId) {
      throw new RuntimeRequestError(ACTIVITY_DETAIL_UNAVAILABLE_MESSAGE);
    }
    dependencies.send(socket, { type: "request.result", requestId: command.requestId, result });
    return "handled";
  });
}
