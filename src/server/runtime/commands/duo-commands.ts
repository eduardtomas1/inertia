import type WebSocket from "ws";

import type { DuoStatusResult, ServerEvent } from "../../../shared/contracts";
import type { DuoLaunchCoordinator } from "../duo/duo-launch-coordinator";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

export interface DuoCommandDependencies {
  coordinator: DuoLaunchCoordinator;
  broadcastSnapshot(): void;
  send(socket: WebSocket, event: ServerEvent): void;
}

function statusResult(
  status: ReturnType<DuoLaunchCoordinator["status"]>,
): DuoStatusResult {
  return { kind: "duo.status", ...status };
}

export function createDuoCommandHandler(
  dependencies: DuoCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler([
    "duo.prepare",
    "duo.dispatch",
    "duo.cancel",
    "duo.pending",
    "duo.status",
    "duo.acknowledge",
    "duo.comparison.retry",
    "duo.comparison.cancel",
  ], async (socket, command) => {
    switch (command.type) {
      case "duo.prepare": {
        const prepared = await dependencies.coordinator.prepare(command.payload);
        dependencies.broadcastSnapshot();
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "duo.prepared",
            ...prepared,
          },
        });
        return "handled";
      }
      case "duo.dispatch": {
        const status = await dependencies.coordinator.dispatch(
          command.payload.launchId,
        );
        dependencies.broadcastSnapshot();
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: statusResult(status),
        });
        return "handled";
      }
      case "duo.cancel": {
        const status = await dependencies.coordinator.cancel(
          command.payload.launchId,
        );
        dependencies.broadcastSnapshot();
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: statusResult(status),
        });
        return "handled";
      }
      case "duo.pending":
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "duo.pending",
            ...dependencies.coordinator.pending(command.payload.projectIds),
          },
        });
        return "handled";
      case "duo.status":
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: statusResult(dependencies.coordinator.status(
            command.payload.launchId,
          )),
        });
        return "handled";
      case "duo.acknowledge": {
        const status = await dependencies.coordinator.acknowledgeInterrupted(
          command.payload.launchId,
        );
        dependencies.broadcastSnapshot();
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: statusResult(status),
        });
        return "handled";
      }
      case "duo.comparison.retry": {
        const status = await dependencies.coordinator.retryComparison(
          command.payload.launchId,
        );
        dependencies.broadcastSnapshot();
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: statusResult(status),
        });
        return "handled";
      }
      case "duo.comparison.cancel": {
        const status = await dependencies.coordinator.cancelComparison(
          command.payload.launchId,
        );
        dependencies.broadcastSnapshot();
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: statusResult(status),
        });
        return "handled";
      }
      default:
        return "not-handled";
    }
  });
}
