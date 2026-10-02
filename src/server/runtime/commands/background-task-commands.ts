import { defineRuntimeCommandHandler, type RuntimeCommandHandler } from "./command-router";
import type { UsageCommandDependencies } from "./usage-commands";

export function createBackgroundTaskCommandHandler(
  dependencies: UsageCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler(["conversation.background-tasks.get"], async (socket, command) => {
    if (command.type !== "conversation.background-tasks.get") return "not-handled";
    dependencies.send(socket, {
      type: "request.result",
      requestId: command.requestId,
      result: dependencies.store.backgroundTasks(command.payload.conversationId, command.payload.before),
    });
    return "handled";
  });
}
