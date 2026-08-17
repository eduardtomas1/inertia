import type WebSocket from "ws";

import type { ServerEvent } from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

export interface UsageCommandDependencies {
  store: RuntimeStore;
  send(socket: WebSocket, event: ServerEvent): void;
}

export function createUsageCommandHandler(
  dependencies: UsageCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler(
    ["usage.dashboard.get", "daily.work.get"],
    async (socket, command) => {
      if (command.type === "daily.work.get") {
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "daily.work",
            dashboard: dependencies.store.dailyWork(command.payload),
          },
        });
        return "handled";
      }
      if (command.type !== "usage.dashboard.get") return "not-handled";
      dependencies.send(socket, {
        type: "request.result",
        requestId: command.requestId,
        result: {
          kind: "usage.dashboard",
          dashboard: dependencies.store.usageDashboard(command.payload),
        },
      });
      return "handled";
    },
  );
}
