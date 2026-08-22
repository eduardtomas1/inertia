import type WebSocket from "ws";

import type {
  RuntimeMutationEvent,
  ServerEvent,
} from "../../../shared/contracts";
import type { AgentWorkflowController } from "../agent-workflow-controller";
import type { ProviderTerminalResumeRegistry } from "../../provider/terminal-resume";
import type { ConversationWorkAuthority } from "../conversation-work-authority";
import { RuntimeRequestError } from "../../runtime-errors";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

export interface AgentWorkflowCommandDependencies {
  workflows: AgentWorkflowController;
  providerTerminalResumes: Pick<ProviderTerminalResumeRegistry, "isActive">;
  conversationWork: Pick<ConversationWorkAuthority, "reserve" | "release">;
  broadcast(event: RuntimeMutationEvent): void;
  send(socket: WebSocket, event: ServerEvent): void;
}

export function createAgentWorkflowCommandHandler(
  dependencies: AgentWorkflowCommandDependencies,
): RuntimeCommandHandler {
  const withNativeSessionReservation = async <T>(
    conversationId: string,
    blockedMessage: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (
      dependencies.providerTerminalResumes.isActive(conversationId)
      || !dependencies.conversationWork.reserve(conversationId)
    ) {
      throw new RuntimeRequestError(blockedMessage);
    }
    try {
      return await operation();
    } finally {
      dependencies.conversationWork.release(conversationId);
    }
  };

  return defineRuntimeCommandHandler([
    "agent.workflow.load",
    "agent.workflow.saved.load",
    "agent.goal.set",
    "agent.goal.clear",
    "agent.skills.list",
  ], async (socket, command) => {
    switch (command.type) {
      case "agent.workflow.load": {
        const workflow = command.payload.refresh
          ? await withNativeSessionReservation(
              command.payload.conversationId,
              "End the active provider session before refreshing this chat's native workflow.",
              async () => await dependencies.workflows.refresh(
                command.payload.conversationId,
              ),
            )
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
        const goal = command.payload.source === "codex-native"
          ? await withNativeSessionReservation(
              command.payload.conversationId,
              "End the active provider session before changing its native goal.",
              async () => await dependencies.workflows.setGoal(command.payload),
            )
          : await dependencies.workflows.setGoal(command.payload);
        dependencies.broadcast({ type: "agent.goal.updated", goal });
        dependencies.send(socket, {
          type: "request.ok",
          requestId: command.requestId,
        });
        return "handled";
      }
      case "agent.goal.clear": {
        const clear = async () => await dependencies.workflows.clearGoal(
          command.payload.conversationId,
          command.payload.source,
        );
        const cleared = command.payload.source === "codex-native"
          ? await withNativeSessionReservation(
              command.payload.conversationId,
              "End the active provider session before changing its native goal.",
              clear,
            )
          : await clear();
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
