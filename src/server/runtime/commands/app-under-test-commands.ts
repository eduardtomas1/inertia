import type WebSocket from "ws";

import { APP_UNDER_TEST_COMMAND_TYPES } from "../../../shared/app-under-test";
import type { ServerEvent } from "../../../shared/contracts";
import { RuntimeRequestError } from "../../runtime-errors";
import { AppUnderTestError } from "../app-under-test/errors";
import type { AppUnderTestLaunchManager } from "../app-under-test/launch-manager";
import { defineRuntimeCommandHandler, type RuntimeCommandHandler } from "./command-router";

export interface AppUnderTestCommandDependencies {
  launches: AppUnderTestLaunchManager;
  /** Throws when the chat does not exist. */
  assertConversation(conversationId: string): void;
  send(socket: WebSocket, event: ServerEvent): void;
}

async function publicErrors<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppUnderTestError) throw new RuntimeRequestError(error.message);
    throw error;
  }
}

/**
 * The App surface's commands. A user launch is marked `startedBy: "user"`, so
 * an agent must always ask before stopping it. The project's agent-access
 * preference does not apply here: it governs only the agent's tools.
 */
export function createAppUnderTestCommandHandler(
  dependencies: AppUnderTestCommandDependencies,
): RuntimeCommandHandler {
  const { launches, send } = dependencies;
  return defineRuntimeCommandHandler([...APP_UNDER_TEST_COMMAND_TYPES], async (socket, command) => {
    switch (command.type) {
      case "app-under-test.launches.list": {
        const { conversationId } = command.payload;
        dependencies.assertConversation(conversationId);
        send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "app-under-test.launches", conversationId, launches: launches.status(conversationId) },
        });
        return "handled";
      }
      case "app-under-test.launch": {
        const { conversationId, kind, actionId } = command.payload;
        dependencies.assertConversation(conversationId);
        const launch = await publicErrors(() => launches.launch({
          conversationId,
          kind,
          ...(actionId === undefined ? {} : { actionId }),
          startedBy: "user",
        }));
        send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "app-under-test.launch", conversationId, launch },
        });
        return "handled";
      }
      case "app-under-test.stop": {
        const { conversationId, launchId } = command.payload;
        dependencies.assertConversation(conversationId);
        const launch = await publicErrors(() => launches.stop(conversationId, launchId));
        send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "app-under-test.launch", conversationId, launch },
        });
        return "handled";
      }
      case "app-under-test.logs.read": {
        const { conversationId, launchId, cursor, limit, grep } = command.payload;
        dependencies.assertConversation(conversationId);
        const page = await publicErrors(() => launches.logs(conversationId, launchId, {
          ...(cursor === undefined ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit }),
          ...(grep === undefined ? {} : { grep }),
        }));
        send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "app-under-test.logs", ...page },
        });
        return "handled";
      }
      case "app-under-test.evidence.list": {
        const { conversationId } = command.payload;
        dependencies.assertConversation(conversationId);
        send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "app-under-test.evidence", conversationId, evidence: launches.listEvidence(conversationId) },
        });
        return "handled";
      }
      default:
        return "not-handled";
    }
  });
}
