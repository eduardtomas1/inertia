import type WebSocket from "ws";
import type { ServerEvent } from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import type { ProjectToolsController } from "../project-tools-controller";
import { defineRuntimeCommandHandler } from "./command-router";

export function createProjectToolsCommandHandler(store: RuntimeStore, controller: ProjectToolsController, send: (socket: WebSocket, event: ServerEvent) => void) {
  return defineRuntimeCommandHandler(["project.tools.load", "project.tools.save", "project.tools.remove"], async (socket, command) => {
    switch (command.type) {
      case "project.tools.load":
        await controller.refresh(command.payload.projectId, command.payload.conversationId);
        send(socket, { type: "request.result", requestId: command.requestId, result: {
          kind: "project.tools", tools: controller.view(command.payload.projectId, command.payload.conversationId),
        } });
        return "handled";
      case "project.tools.save":
        store.project(command.payload.projectId);
        store.projectTools.save(command.payload.projectId, command.payload.connection, command.payload.id, command.payload.revision);
        return "mutation";
      case "project.tools.remove":
        store.project(command.payload.projectId);
        controller.assertRemovable(command.payload.projectId, command.payload.id);
        store.projectTools.remove(command.payload.projectId, command.payload.id, command.payload.revision);
        return "mutation";
      default: return "not-handled";
    }
  });
}
