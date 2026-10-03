import type { WorkspaceRun } from "../../../shared/contracts";
import { defineRuntimeCommandHandler, type RuntimeCommandHandler } from "./command-router";
import type { UsageCommandDependencies } from "./usage-commands";

export interface BackgroundTaskCommandDependencies extends UsageCommandDependencies {
  canStopWorkspaceRun?(run: WorkspaceRun): boolean;
}

export function createBackgroundTaskCommandHandler(
  dependencies: BackgroundTaskCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler(["conversation.background-tasks.get"], async (socket, command) => {
    if (command.type !== "conversation.background-tasks.get") return "not-handled";
    const result = dependencies.store.backgroundTasks(command.payload.conversationId, command.payload.before);
    dependencies.send(socket, {
      type: "request.result",
      requestId: command.requestId,
      result: {
        ...result,
        runs: result.runs.map((run) => ({ ...run, canStop: dependencies.canStopWorkspaceRun?.(run) ?? false })),
      },
    });
    return "handled";
  });
}
