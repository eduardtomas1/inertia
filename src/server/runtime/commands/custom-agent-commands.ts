import type { RuntimeStore } from "../../database";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

export interface CustomAgentCommandDependencies {
  store: Pick<RuntimeStore, "customAgents">;
}

export function createCustomAgentCommandHandler(
  dependencies: CustomAgentCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler([
    "custom-agent.create",
    "custom-agent.update",
    "custom-agent.duplicate",
    "custom-agent.delete",
    "custom-agent.reorder",
  ], async (_socket, command) => {
    const agents = dependencies.store.customAgents();
    switch (command.type) {
      case "custom-agent.create":
        agents.create(command.payload.agent, {
          onHandleConflict: command.payload.onHandleConflict,
        });
        return "mutation";
      case "custom-agent.update": {
        const { agentId, expectedRevision, ...patch } = command.payload;
        agents.update(agentId, expectedRevision, patch);
        return "mutation";
      }
      case "custom-agent.duplicate":
        agents.duplicate(command.payload.agentId, command.payload.expectedRevision);
        return "mutation";
      case "custom-agent.delete":
        agents.delete(command.payload.agentId, command.payload.expectedRevision);
        return "mutation";
      case "custom-agent.reorder":
        agents.reorder(command.payload.expectedAgentIds, command.payload.agentIds);
        return "mutation";
      default:
        return "not-handled";
    }
  });
}
