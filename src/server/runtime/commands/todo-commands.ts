import type WebSocket from "ws";

import type { ClientCommand, ProviderInfo, ServerEvent } from "../../../shared/contracts";
import { todoPromptContent, type Todo } from "../../../shared/todos";
import type { RuntimeStore } from "../../database";
import { TodoRepositoryError } from "../../persistence/todo-repository";
import { RuntimeRequestError } from "../../runtime-errors";
import type { BackendProfileController } from "../backends/backend-profile-controller";
import type {
  ConversationCreatePayload,
  ConversationCreationService,
} from "../conversation-creation-service";
import type { TurnController } from "../turns/turn-controller";
import { isHeld, UPDATE_HOLD_MESSAGE } from "../update-hold";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

const MAX_CONVERSATION_TITLE_LENGTH = 120;

type TodoStartCommand = Extract<ClientCommand, { type: "todo.start" }>;

export interface TodoCommandDependencies {
  store: RuntimeStore;
  creation: Pick<ConversationCreationService, "create" | "canonicalSelection">;
  turns: Pick<TurnController, "queue" | "start" | "failBeforeStart">;
  backendProfileController: Pick<BackendProfileController, "readiness">;
  enableProviders: boolean;
  verifyProviderInstallation?(providerId: ProviderInfo["id"]): Promise<void>;
  providerInfo(): readonly ProviderInfo[];
  broadcastSnapshot(): void;
  send(socket: WebSocket, event: ServerEvent): void;
}

function conversationTitle(title: string): string {
  let result = "";
  for (const character of title) {
    if (result.length + character.length > MAX_CONVERSATION_TITLE_LENGTH) break;
    result += character;
  }
  return result.trim();
}

async function assertRouteReady(
  dependencies: TodoCommandDependencies,
  payload: ConversationCreatePayload,
): Promise<void> {
  if (!dependencies.enableProviders) return;
  const { providerId, selection } = dependencies.creation.canonicalSelection(payload);
  await dependencies.verifyProviderInstallation?.(providerId);
  const provider = dependencies.providerInfo().find(({ id }) => id === providerId);
  const readiness = await dependencies.backendProfileController.readiness(selection, provider);
  if (readiness && !readiness.ready) {
    throw new RuntimeRequestError(readiness.message ?? "The selected model backend is unavailable.");
  }
  if (!readiness && !provider?.canRun) {
    throw new RuntimeRequestError(
      provider?.statusMessage ?? "This agent is not ready. Open Settings to finish setup.",
    );
  }
}

export function createTodoCommandHandler(
  dependencies: TodoCommandDependencies,
): RuntimeCommandHandler {
  const starting = new Set<string>();

  const start = async (socket: WebSocket, command: TodoStartCommand): Promise<void> => {
    if (isHeld()) throw new RuntimeRequestError(UPDATE_HOLD_MESSAGE);
    const todo = dependencies.store.todos.get(command.payload.id);
    if (!todo) throw new RuntimeRequestError("That task no longer exists.");
    if (todo.conversationId !== null) {
      throw new RuntimeRequestError("That task is already handed to an agent.");
    }
    const payload = {
      ...command.payload.conversation,
      title: conversationTitle(todo.title),
      activate: false,
    };
    await assertRouteReady(dependencies, payload);
    const conversation = await dependencies.creation.create(payload, command.requestId);
    try {
      let linked: Todo;
      try {
        linked = dependencies.store.todos.link(todo.id, conversation.id);
      } catch (error) {
        const unlinked = new RuntimeRequestError("The chat was created, but the task could not be linked to it.");
        if (dependencies.store.conversationWorktrees.get(conversation.id)?.ownsWorktree) throw unlinked;
        try {
          dependencies.store.deleteConversation(conversation.id);
        } catch {
          throw unlinked;
        }
        throw error instanceof TodoRepositoryError
          ? error
          : new RuntimeRequestError("The task could not be handed to an agent.");
      }
      dependencies.store.lockConversationTitle(conversation.id);
      const content = todoPromptContent(linked);
      if (dependencies.enableProviders) {
        let queued: ReturnType<TodoCommandDependencies["turns"]["queue"]>;
        try {
          queued = dependencies.turns.queue({
            conversationId: conversation.id,
            content,
            activateConversation: false,
            contextRequestId: command.requestId,
            turnCheckpoint: true,
            skills: [],
          });
        } catch {
          if (!dependencies.store.latestAgentTurnForConversation(conversation.id)) {
            dependencies.store.createMessage(conversation.id, content, "user", [], null, undefined, {
              activateConversation: false,
            });
          }
          throw new RuntimeRequestError("The chat was created, but its first turn could not start.");
        }
        if (!dependencies.turns.start(queued.turn.id)) {
          dependencies.turns.failBeforeStart(conversation.id, "The task's chat could not start.");
          throw new RuntimeRequestError("The chat was created, but its first turn could not start.");
        }
      } else {
        dependencies.store.createMessage(conversation.id, content, "user", [], null, undefined, {
          activateConversation: false,
        });
      }
    } finally {
      dependencies.broadcastSnapshot();
    }
    dependencies.send(socket, {
      type: "request.result",
      requestId: command.requestId,
      result: { kind: "todo.started", conversationId: conversation.id },
    });
  };

  return defineRuntimeCommandHandler([
    "todo.create",
    "todo.update",
    "todo.delete",
    "todo.start",
  ], async (socket, command) => {
    switch (command.type) {
      case "todo.create":
        dependencies.store.todos.create(command.payload);
        return "mutation";
      case "todo.update":
        dependencies.store.todos.update(command.payload.id, command.payload.patch);
        return "mutation";
      case "todo.delete":
        dependencies.store.todos.delete(command.payload.id);
        return "mutation";
      case "todo.start": {
        const { id } = command.payload;
        if (starting.has(id)) throw new RuntimeRequestError("That task is already starting.");
        starting.add(id);
        try {
          await start(socket, command);
        } finally {
          starting.delete(id);
        }
        return "handled";
      }
      default:
        return "not-handled";
    }
  });
}
