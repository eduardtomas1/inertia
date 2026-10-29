import type WebSocket from "ws";

import { AGENT_SECRET_SAVE_ERRORS } from "../../../shared/agent-secret-save-errors";
import { AGENT_SECRET_REVOKE_ERRORS } from "../../../shared/agent-secret-revoke-errors";
import type { ServerEvent } from "../../../shared/contracts";
import type { SecretRequestListEntry } from "../../../shared/contracts/client-command/secret-requests";
import { RuntimeRequestError } from "../../runtime-errors";
import { defineRuntimeCommandHandler, type RuntimeCommandHandler } from "./command-router";

export const SECRET_REQUEST_NOT_PENDING_MESSAGE = AGENT_SECRET_SAVE_ERRORS.notPending;
export const SECRET_REQUEST_NOT_ACTIVE_MESSAGE = AGENT_SECRET_REVOKE_ERRORS.notActive;
export const SECRET_REQUEST_IN_USE_MESSAGE = AGENT_SECRET_REVOKE_ERRORS.inUse;

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
