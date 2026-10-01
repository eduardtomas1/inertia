import type WebSocket from "ws";
import type { ServerEvent } from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import { defineRuntimeCommandHandler, type RuntimeCommandHandler } from "./command-router";

export function createProjectMemoryCommandHandler(input: {
  store: RuntimeStore;
  send(socket: WebSocket, event: ServerEvent): void;
}): RuntimeCommandHandler {
  return defineRuntimeCommandHandler([
    "project.memory.load", "project.memory.save", "project.memory.delete",
    "project.memory.toggle", "project.memory.context", "project.memory.source",
  ], async (socket, command) => {
    const memory = input.store.projectMemory;
    if (command.type === "project.memory.source") {
      input.send(socket, { type: "request.result", requestId: command.requestId,
        result: { kind: "project.memory.source", preview: memory.sourcePreview(command.payload) } });
      return "handled";
    }
    if (command.type === "project.memory.context") {
      input.send(socket, { type: "request.result", requestId: command.requestId,
        result: { kind: "project.memory.context", ...command.payload, context: memory.sentContext(command.payload) } });
      return "handled";
    }
    const state = command.type === "project.memory.load" ? memory.load(command.payload)
      : command.type === "project.memory.save" ? memory.save(command.payload)
        : command.type === "project.memory.delete" ? memory.remove(command.payload)
          : command.type === "project.memory.toggle" ? memory.toggle(command.payload) : null;
    if (!state) return "not-handled";
    input.send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "project.memory", state } });
    return "handled";
  });
}
