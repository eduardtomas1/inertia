import type WebSocket from "ws";

import type { DuoStatusResult, ServerEvent } from "../../../shared/contracts";
import type { DuoLaunchCoordinator } from "../duo/duo-launch-coordinator";
import { RuntimeRequestError } from "../../runtime-errors";
import {
  MAIN_RUNTIME_CLIENT_AUTHORITY,
  type RuntimeClientAuthority,
} from "../runtime-client-authority";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

export interface DuoCommandDependencies {
  coordinator: DuoLaunchCoordinator;
  visibleLaunchIds(
    authority: RuntimeClientAuthority,
    launchIds: readonly string[],
  ): string[];
  broadcastSnapshot(): void;
  send(socket: WebSocket, event: ServerEvent): void;
}

function statusResult(
  status: ReturnType<DuoLaunchCoordinator["status"]>,
): DuoStatusResult {
  return { kind: "duo.status", ...status };
}

const DUO_CHAT_STILL_BUSY =
  "A chat in this Duo is still working, or Inertia has not confirmed its agent stopped. Let it finish or stop it, then try again.";

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
  ], async (socket, command, authority = MAIN_RUNTIME_CLIENT_AUTHORITY) => {
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
      case "duo.pending": {
        const pending = dependencies.coordinator.pending(
          command.payload.projectIds,
          command.payload.page,
        );
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "duo.pending",
            launchIds: dependencies.visibleLaunchIds(
              authority,
              pending.launchIds,
            ),
            hasMore: pending.hasMore,
          },
        });
        return "handled";
      }
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
        if (status.state === "interrupted") {
          throw new RuntimeRequestError(DUO_CHAT_STILL_BUSY);
        }
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
        if (
          status.comparison
          && status.comparison.state !== "cancelled"
          && status.comparison.state !== "completed"
        ) {
          throw new RuntimeRequestError(DUO_CHAT_STILL_BUSY);
        }
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
