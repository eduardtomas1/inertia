import type WebSocket from "ws";

import type { RuntimeMutationEvent, ServerEvent } from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

type ServerRequestResult = Extract<ServerEvent, { type: "request.result" }>["result"];

export interface LibraryCommandDependencies {
  store: Pick<RuntimeStore, "library">;
  broadcast(event: RuntimeMutationEvent): void;
  send(socket: WebSocket, event: ServerEvent): void;
}

export function createLibraryCommandHandler(
  dependencies: LibraryCommandDependencies,
): RuntimeCommandHandler {
  const library = () => dependencies.store.library;

  const settle = (
    socket: WebSocket,
    requestId: string,
    result?: ServerRequestResult,
  ): "handled" => {
    dependencies.broadcast({ type: "library.updated", library: library().snapshot() });
    dependencies.send(socket, result
      ? { type: "request.result", requestId, result }
      : { type: "request.ok", requestId });
    return "handled";
  };

  return defineRuntimeCommandHandler([
    "library.category.create",
    "library.category.rename",
    "library.category.delete",
    "library.answer.save",
    "library.answer.update",
    "library.answer.remove",
    "library.pages.list",
  ], async (socket, command) => {
    switch (command.type) {
      case "library.category.create":
        return settle(socket, command.requestId, {
          kind: "library.category",
          category: library().createCategory(command.payload.name),
        });
      case "library.category.rename":
        return settle(socket, command.requestId, {
          kind: "library.category",
          category: library().renameCategory(command.payload.categoryId, command.payload.name),
        });
      case "library.category.delete":
        library().deleteCategory(command.payload.categoryId);
        return settle(socket, command.requestId);
      case "library.answer.save":
        return settle(socket, command.requestId, {
          kind: "library.answer",
          savedAnswer: library().saveAnswer(command.payload),
        });
      case "library.answer.update": {
        const { savedAnswerId, ...patch } = command.payload;
        return settle(socket, command.requestId, {
          kind: "library.answer",
          savedAnswer: library().updateAnswer(savedAnswerId, patch),
        });
      }
      case "library.answer.remove":
        library().removeAnswer(command.payload.savedAnswerId);
        return settle(socket, command.requestId);
      case "library.pages.list":
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "library.pages", pages: library().pages() },
        });
        return "handled";
      default:
        return "not-handled";
    }
  });
}
