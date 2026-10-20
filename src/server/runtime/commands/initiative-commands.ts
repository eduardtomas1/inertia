import type { RuntimeStore } from "../../database";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

export interface InitiativeCommandDependencies {
  store: Pick<RuntimeStore, "initiatives">;
}

/**
 * Initiative commands are organisational: they change the initiative table and
 * `conversations.initiative_id` only. They never touch a chat's project,
 * workspace, worktree, provider route or session.
 */
export function createInitiativeCommandHandler(
  dependencies: InitiativeCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler([
    "initiative.create",
    "initiative.update",
    "initiative.delete",
    "initiative.assign",
  ], async (_socket, command) => {
    switch (command.type) {
      case "initiative.create": {
        const { conversationId, ...initiative } = command.payload;
        dependencies.store.initiatives.create(initiative, conversationId);
        return "mutation";
      }
      case "initiative.update": {
        const { id, expectedRevision, ...patch } = command.payload;
        dependencies.store.initiatives.update(id, expectedRevision, patch);
        return "mutation";
      }
      case "initiative.delete":
        dependencies.store.initiatives.delete(command.payload.id);
        return "mutation";
      case "initiative.assign":
        dependencies.store.initiatives.assignConversation(
          command.payload.conversationId,
          command.payload.initiativeId,
        );
        return "mutation";
      default:
        return "not-handled";
    }
  });
}
