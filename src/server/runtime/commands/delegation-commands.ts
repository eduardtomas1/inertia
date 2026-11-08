import { DELEGATION_COMMAND_TYPES } from "../../../shared/contracts/client-command/delegation";
import type { ServerEvent } from "../../../shared/contracts";
import { DelegationError } from "../../orchestration-v2/delegation-repository";
import { RuntimeRequestError } from "../../runtime-errors";
import { DelegationTaskError, type DelegationTaskService } from "../delegation/task-service";
import { defineRuntimeCommandHandler, type RuntimeCommandHandler } from "./command-router";

export interface DelegationCommandDependencies {
  delegation: DelegationTaskService;
  send(socket: Parameters<RuntimeCommandHandler>[0], event: ServerEvent): void;
  broadcastSnapshot(): void;
}

function publicDelegationError(error: unknown): unknown {
  return error instanceof DelegationError || error instanceof DelegationTaskError
    ? new RuntimeRequestError(error.message)
    : error;
}

export function createDelegationCommandHandler(dependencies: DelegationCommandDependencies): RuntimeCommandHandler {
  const { delegation } = dependencies;
  return defineRuntimeCommandHandler([...DELEGATION_COMMAND_TYPES], async (socket, command) => {
    const reply = (result: Extract<ServerEvent, { type: "request.result" }>["result"]): "handled" => {
      dependencies.send(socket, { type: "request.result", requestId: command.requestId, result });
      return "handled";
    };
    try {
      switch (command.type) {
        case "delegation.task.read":
          return reply({ kind: "delegation.task", task: delegation.view(command.payload.taskId) });
        case "delegation.task.cancel": {
          const target = delegation.prepareCancel(null, command.payload.taskId);
          const cancelled = await delegation.cancel(target, `user-${command.requestId}`);
          dependencies.broadcastSnapshot();
          return reply({ kind: "delegation.task.cancel", ...cancelled });
        }
        case "delegation.delivery.dismiss": {
          const { parentConversationId, taskIds } = command.payload;
          const disposed = await delegation.dismiss(parentConversationId, taskIds, `user-${command.requestId}`);
          dependencies.broadcastSnapshot();
          return reply({ kind: "delegation.delivery", parentConversationId, action: "dismissed", taskIds: disposed,
            generation: null });
        }
        case "delegation.delivery.send": {
          const { parentConversationId } = command.payload;
          const sent = await delegation.send(parentConversationId);
          dependencies.broadcastSnapshot();
          return reply({ kind: "delegation.delivery", parentConversationId, action: "sent", taskIds: sent.taskIds,
            generation: sent.generation });
        }
        case "delegation.wake.set": {
          const task = await delegation.setWake(command.payload.taskId, command.payload.armed, `user-${command.requestId}`);
          dependencies.broadcastSnapshot();
          return reply({ kind: "delegation.task", task });
        }
        default:
          return "not-handled";
      }
    } catch (error) {
      throw publicDelegationError(error);
    }
  });
}
