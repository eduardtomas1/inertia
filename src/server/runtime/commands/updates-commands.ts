import type WebSocket from "ws";

import type { ServerEvent } from "../../../shared/contracts";
import {
  finishUpdateEverything,
  runUpdateEverything,
  type UpdateEverythingDependencies,
} from "../update-everything";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

export interface UpdatesCommandDependencies extends UpdateEverythingDependencies {
  send(socket: WebSocket, event: ServerEvent): void;
}

export function createUpdatesCommandHandler(
  dependencies: UpdatesCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler([
    "updates.run",
    "updates.finish",
  ], async (socket, command) => {
    switch (command.type) {
      case "updates.run":
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: await runUpdateEverything(dependencies, command.payload, socket),
        });
        return "handled";
      case "updates.finish":
        finishUpdateEverything(command.payload.installed);
        dependencies.send(socket, { type: "request.ok", requestId: command.requestId });
        return "handled";
      default:
        return "not-handled";
    }
  });
}
