import type WebSocket from "ws";

import type {
  RuntimeMutationEvent,
  ServerEvent,
} from "../../../shared/contracts";
import type { AgentWorkflowController } from "../agent-workflow-controller";
import type { ProviderTerminalResumeRegistry } from "../../provider/terminal-resume";
import { RuntimeRequestError } from "../../runtime-errors";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

export interface AgentWorkflowCommandDependencies {
  workflows: AgentWorkflowController;
  providerTerminalResumes: Pick<ProviderTerminalResumeRegistry, "isActive">;
  broadcast(event: RuntimeMutationEvent): void;
  send(socket: WebSocket, event: ServerEvent): void;
}

export function createAgentWorkflowCommandHandler(
  dependencies: AgentWorkflowCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler([
    "agent.workflow.load",
    "agent.workflow.saved.load",
    "agent.goal.set",
    "agent.goal.clear",
    "agent.skills.list",
  ], async (socket, command) => {
    switch (command.type) {
      case "agent.workflow.load": {
        if (
          command.payload.refresh
          && dependencies.providerTerminalResumes.isActive(
            command.payload.conversationId,
          )
        ) {
          throw new RuntimeRequestError(
            "End the resumed provider terminal before refreshing this chat's native workflow.",
          );
        }
        const workflow = command.payload.refresh
          ? await dependencies.workflows.refresh(command.payload.conversationId)
          : dependencies.workflows.state(command.payload.conversationId);
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "agent.workflow", workflow },
        });
        return "handled";
      }
      case "agent.workflow.saved.load": {
        const workflow = dependencies.workflows.state(
          command.payload.conversationId,
          false,
        );
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "agent.workflow", workflow },
        });
        return "handled";
      }
      case "agent.goal.set": {
        if (
          command.payload.source === "codex-native"
          && dependencies.providerTerminalResumes.isActive(
            command.payload.conversationId,
          )
        ) {
          throw new RuntimeRequestError(
            "End the resumed provider terminal before changing its native goal.",
          );
        }
        const goal = await dependencies.workflows.setGoal(command.payload);
        dependencies.broadcast({ type: "agent.goal.updated", goal });
        dependencies.send(socket, {
          type: "request.ok",
          requestId: command.requestId,
        });
        return "handled";
      }
      case "agent.goal.clear": {
        if (
          command.payload.source === "codex-native"
          && dependencies.providerTerminalResumes.isActive(
            command.payload.conversationId,
          )
        ) {
          throw new RuntimeRequestError(
            "End the resumed provider terminal before changing its native goal.",
          );
        }
        const cleared = await dependencies.workflows.clearGoal(
          command.payload.conversationId,
          command.payload.source,
        );
        if (cleared) {
          dependencies.broadcast({
            type: "agent.goal.cleared",
            conversationId: command.payload.conversationId,
            source: command.payload.source,
          });
        }
        dependencies.send(socket, {
          type: "request.ok",
          requestId: command.requestId,
        });
        return "handled";
      }
      case "agent.skills.list": {
        await dependencies.workflows.listSkills(
          command.payload.conversationId,
          command.payload.forceReload ?? false,
        );
        const workflow = dependencies.workflows.state(
          command.payload.conversationId,
        );
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "agent.skills",
            conversationId: command.payload.conversationId,
            skills: workflow.skills,
            skillDiscovery: workflow.skillDiscovery,
          },
        });
        return "handled";
      }
      default:
        return "not-handled";
    }
  });
}
