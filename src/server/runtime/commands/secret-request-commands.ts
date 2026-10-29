import type WebSocket from "ws";

import type { ServerEvent } from "../../../shared/contracts";
import type { SecretRequestListEntry } from "../../../shared/contracts/client-command/secret-requests";
import { RuntimeRequestError } from "../../runtime-errors";
import { defineRuntimeCommandHandler, type RuntimeCommandHandler } from "./command-router";

export const SECRET_REQUEST_NOT_PENDING_MESSAGE = "That secret request is no longer pending.";
export const SECRET_REQUEST_NOT_ACTIVE_MESSAGE = "That secret is no longer active.";
export const SECRET_REQUEST_IN_USE_MESSAGE = "A program is still using this secret's file, so Inertia couldn't delete it. Close it and try again.";

export interface SecretRequestCommandService {
  decline(conversationId: string, requestId: string): Promise<boolean>;
  revoke(requestId: string): Promise<"revoked" | "not-active" | "in-use">;
  list(): SecretRequestListEntry[];
}

export interface SecretRequestCommandDependencies {
  service(): SecretRequestCommandService | null;
  send(socket: WebSocket, event: ServerEvent): void;
}

export function createSecretRequestCommandHandler(
  dependencies: SecretRequestCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler([
    "secret-request.decline",
    "secret-request.revoke",
    "secret-request.list",
  ], async (socket, command) => {
    const service = dependencies.service();
    switch (command.type) {
      case "secret-request.decline": {
        const declined = await service?.decline(command.payload.conversationId, command.payload.requestId) ?? false;
        if (!declined) throw new RuntimeRequestError(SECRET_REQUEST_NOT_PENDING_MESSAGE);
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "secret-request.decline", status: "declined" },
        });
        return "handled";
      }
      case "secret-request.revoke": {
        const outcome = await service?.revoke(command.payload.requestId) ?? "not-active";
        if (outcome === "in-use") throw new RuntimeRequestError(SECRET_REQUEST_IN_USE_MESSAGE);
        if (outcome !== "revoked") throw new RuntimeRequestError(SECRET_REQUEST_NOT_ACTIVE_MESSAGE);
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "secret-request.revoke", status: "revoked" },
        });
        return "handled";
      }
      case "secret-request.list":
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "secret-request.list", secrets: service?.list() ?? [] },
        });
        return "handled";
      default:
        return "not-handled";
    }
  });
}
