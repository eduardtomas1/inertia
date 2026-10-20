import type WebSocket from "ws";

import type { RuntimeStore } from "../../database";
import type { ServerEvent } from "../../../shared/contracts";
import { InitiativeRepositoryError } from "../../persistence/initiative-repository";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

export interface InitiativeCommandDependencies {
  store: Pick<RuntimeStore, "initiatives">;
  send(socket: WebSocket, event: ServerEvent): void;
}

/**
 * Initiative commands are organisational: they change the initiative tables
 * and `conversations.initiative_id` only. They never touch a chat's project,
 * workspace, worktree, provider route or session. Brief and note edits reach
 * member chats on their next turn, through turn preparation.
 */
export function createInitiativeCommandHandler(
  dependencies: InitiativeCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler([
    "initiative.create",
    "initiative.update",
    "initiative.delete",
    "initiative.assign",
    "initiative.brief.update",
    "initiative.notes.list",
    "initiative.note.create",
    "initiative.note.update",
    "initiative.note.resolve",
    "initiative.note.delete",
  ], async (socket, command) => {
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
      case "initiative.brief.update":
        dependencies.store.initiatives.updateBrief(
          command.payload.id,
          command.payload.expectedBriefRevision,
          command.payload.brief,
        );
        return "mutation";
      case "initiative.notes.list": {
        const { initiativeId } = command.payload;
        if (!dependencies.store.initiatives.get(initiativeId)) {
          throw new InitiativeRepositoryError("That initiative no longer exists.");
        }
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "initiative.notes",
            initiativeId,
            notes: dependencies.store.initiatives.notes.list(initiativeId),
          },
        });
        return "handled";
      }
      case "initiative.note.create":
        // Notes written on the Initiative page are the user's and apply at once.
        dependencies.store.initiatives.notes.create({ ...command.payload, provenance: "user" });
        return "mutation";
      case "initiative.note.update": {
        const { id, expectedRevision, ...edits } = command.payload;
        dependencies.store.initiatives.notes.update(id, expectedRevision, edits);
        return "mutation";
      }
      case "initiative.note.resolve": {
        const { id, expectedRevision, decision, ...edits } = command.payload;
        dependencies.store.initiatives.notes.resolve(id, expectedRevision, decision, edits);
        return "mutation";
      }
      case "initiative.note.delete":
        dependencies.store.initiatives.notes.delete(command.payload.id);
        return "mutation";
      default:
        return "not-handled";
    }
  });
}
