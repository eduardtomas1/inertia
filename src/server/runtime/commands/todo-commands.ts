import type WebSocket from "ws";

import type { ClientCommand, ProviderInfo, RuntimeMutationEvent, ServerEvent } from "../../../shared/contracts";
import { todoPromptContent, type Todo } from "../../../shared/todos";
import { isAgentTurnTerminalStatus } from "../../../shared/turn-lifecycle";
import type { RuntimeStore } from "../../database";
import { RecordNotFoundError } from "../../persistence/errors";
import {
  assertTodoCanHandOff,
  TODO_MISSING_MESSAGE,
  TODO_SOURCE_CHAT_MISSING_MESSAGE,
  TODO_SOURCE_CHAT_PROJECT_MESSAGE,
  TodoRepositoryError,
} from "../../persistence/todo-repository";
import { RuntimeRequestError, USER_CORRECTABLE_REQUEST } from "../../runtime-errors";
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
type TodoCreateCommand = Extract<ClientCommand, { type: "todo.create" }>;

export interface TodoCommandDependencies {
  store: RuntimeStore;
  creation: Pick<ConversationCreationService, "create" | "canonicalSelection">;
  turns: Pick<TurnController, "queue" | "start" | "failBeforeStart" | "isActive">;
  backendProfileController: Pick<BackendProfileController, "readiness">;
  enableProviders: boolean;
  verifyProviderInstallation?(providerId: ProviderInfo["id"]): Promise<void>;
  providerInfo(): readonly ProviderInfo[];
  broadcast(event: RuntimeMutationEvent): void;
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

function userError(message: string): RuntimeRequestError {
  return new RuntimeRequestError(message, USER_CORRECTABLE_REQUEST);
}

function assertChatIdle(dependencies: TodoCommandDependencies, conversationId: string): void {
  const latest = dependencies.store.latestAgentTurnForConversation(conversationId);
  if (
    dependencies.turns.isActive(conversationId)
    || (latest !== null && !isAgentTurnTerminalStatus(latest.status))
  ) throw userError("Stop the agent first.");
  const continuation = dependencies.store.restartContinuations.forConversation(conversationId);
  if (continuation?.state === "waiting" || continuation?.state === "dispatching") {
    throw userError("This chat continues after the update. Try again once it has.");
  }
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

/**
 * A task written from a chat remembers that chat as its source; it is not
 * handed to the chat. The chat must still exist and belong to the task's
 * project.
 */
function assertSourceConversation(
  store: RuntimeStore,
  conversationId: string,
  projectId: string | null | undefined,
): void {
  let conversation: ReturnType<RuntimeStore["conversation"]>;
  try {
    conversation = store.conversation(conversationId);
  } catch (error) {
    if (error instanceof RecordNotFoundError) throw userError(TODO_SOURCE_CHAT_MISSING_MESSAGE);
    throw error;
  }
  if (conversation.projectId !== projectId) {
    throw userError(TODO_SOURCE_CHAT_PROJECT_MESSAGE);
  }
}

function createTodo(store: RuntimeStore, command: TodoCreateCommand): void {
  const draft = command.payload;
  if (draft.sourceConversationId) {
    assertSourceConversation(store, draft.sourceConversationId, draft.projectId);
  }
  store.todos.create(draft);
}

export function createTodoCommandHandler(
  dependencies: TodoCommandDependencies,
): RuntimeCommandHandler {
  const starting = new Set<string>();

  const start = async (socket: WebSocket, command: TodoStartCommand): Promise<void> => {
    if (isHeld()) throw new RuntimeRequestError(UPDATE_HOLD_MESSAGE);
    const { replaces } = command.payload;
    const todo = dependencies.store.todos.get(command.payload.id);
    if (!todo) throw userError(TODO_MISSING_MESSAGE);
    assertTodoCanHandOff(todo, replaces);
    if (replaces !== undefined) assertChatIdle(dependencies, replaces);
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
        if (isHeld()) throw new RuntimeRequestError(UPDATE_HOLD_MESSAGE);
        if (replaces !== undefined) assertChatIdle(dependencies, replaces);
        linked = dependencies.store.todos.link(todo.id, conversation.id, { replaces });
      } catch (error) {
        const unlinked = new RuntimeRequestError("The chat was created, but the task could not be linked to it.");
        if (dependencies.store.conversationWorktrees.get(conversation.id)?.ownsWorktree) throw unlinked;
        try {
          dependencies.store.deleteConversation(conversation.id);
        } catch {
          throw unlinked;
        }
        throw error instanceof TodoRepositoryError || error instanceof RuntimeRequestError
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

  const settleTodos = (socket: WebSocket, requestId: string): "handled" => {
    dependencies.broadcast({ type: "todos.updated", todos: dependencies.store.todos.list() });
    dependencies.send(socket, { type: "request.ok", requestId });
    return "handled";
  };

  return defineRuntimeCommandHandler([
    "todo.create",
    "todo.update",
    "todo.delete",
    "todo.clearDone",
    "todo.start",
  ], async (socket, command) => {
    switch (command.type) {
      case "todo.create":
        createTodo(dependencies.store, command);
        return settleTodos(socket, command.requestId);
      case "todo.update":
        dependencies.store.todos.update(command.payload.id, command.payload.patch);
        return settleTodos(socket, command.requestId);
      case "todo.delete":
        dependencies.store.todos.delete(command.payload.id);
        return settleTodos(socket, command.requestId);
      case "todo.clearDone":
        dependencies.store.todos.clearDone(command.payload.ids);
        return settleTodos(socket, command.requestId);
      case "todo.start": {
        const { id } = command.payload;
        if (starting.has(id)) throw userError("That task is already starting.");
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
