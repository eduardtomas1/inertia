import type WebSocket from "ws";

import type { RuntimeStore } from "../../database";
import type { ModelSelection, ServerEvent } from "../../../shared/contracts";
import type { Initiative, InitiativePreferencesPatch } from "../../../shared/initiatives";
import { InitiativeRepositoryError } from "../../persistence/initiative-repository";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

export interface InitiativeCommandDependencies {
  store: Pick<RuntimeStore, "initiatives">;
  send(socket: WebSocket, event: ServerEvent): void;
  /** The canonical selection when it can be a new-chat default; throws a readable refusal otherwise. */
  validateDefaultModel(selection: ModelSelection): ModelSelection;
  /** Creates the initiative's contained skills folder; throws a readable refusal. */
  ensureSkillsFolder(initiativeId: string): void;
}

/**
 * Canonicalises a default-model change. The model is validated with its
 * reasoning level, like a project default; a new model without a level starts
 * at the model's default, and clearing the model clears the level.
 */
function canonicalModelPreferences(
  dependencies: InitiativeCommandDependencies,
  current: Initiative,
  patch: InitiativePreferencesPatch,
): InitiativePreferencesPatch {
  if (patch.defaultModel === undefined && patch.defaultReasoningEffort === undefined) return patch;
  const model = patch.defaultModel === undefined ? current.preferences.defaultModel : patch.defaultModel;
  if (model === null) return { ...patch, defaultModel: null, defaultReasoningEffort: null };
  const reasoningEffort = patch.defaultReasoningEffort !== undefined
    ? patch.defaultReasoningEffort
    : patch.defaultModel === undefined ? current.preferences.defaultReasoningEffort : null;
  const canonical = dependencies.validateDefaultModel({ ...model, reasoningEffort });
  return {
    ...patch,
    defaultModel: { ...canonical, reasoningEffort: null },
    defaultReasoningEffort: canonical.reasoningEffort,
  };
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
        const { id, expectedRevision, preferences, ...patch } = command.payload;
        let canonical: InitiativePreferencesPatch | undefined;
        if (preferences) {
          // Read once: settings changes are checked against the stored settings,
          // and the update itself re-checks the revision atomically.
          const current = dependencies.store.initiatives.get(id);
          if (!current) throw new InitiativeRepositoryError("That initiative no longer exists.");
          canonical = canonicalModelPreferences(dependencies, current, preferences);
          // The folder exists before any chat is told it may use it.
          if (canonical.skillsFolder === true) dependencies.ensureSkillsFolder(id);
        }
        dependencies.store.initiatives.update(id, expectedRevision, {
          ...patch,
          ...(canonical ? { preferences: canonical } : {}),
        });
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
            // Rejected notes are listed too, so the page can show and delete them.
            notes: dependencies.store.initiatives.notes.list(initiativeId, { includeRejected: true }),
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
