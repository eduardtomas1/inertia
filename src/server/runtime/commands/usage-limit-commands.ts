import type WebSocket from "ws";
import type { ServerEvent } from "../../../shared/contracts";
import type { UsageLimitsService } from "../../usage/limits-service";
import { defineRuntimeCommandHandler, type RuntimeCommandHandler } from "./command-router";

export function createUsageLimitCommandHandler(limits: UsageLimitsService, send: (socket: WebSocket, event: ServerEvent) => void): RuntimeCommandHandler {
  return defineRuntimeCommandHandler(["usage.limits.get", "usage.source.save", "usage.source.remove", "usage.reset.prepare", "usage.reset.confirm"], async (socket, command) => {
    switch (command.type) {
      case "usage.limits.get":
        send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "usage.limits", snapshot: command.payload.refresh ? await limits.refresh(command.payload.force) : limits.snapshot() } }); break;
      case "usage.source.save":
        send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "usage.limits", snapshot: await limits.saveSource(command.payload) } }); break;
      case "usage.source.remove":
        send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "usage.limits", snapshot: await limits.removeSource(command.payload.id) } }); break;
      case "usage.reset.prepare":
        send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "usage.reset.confirmation", confirmation: limits.prepareReset(command.payload.accountId) } }); break;
      case "usage.reset.confirm":
        send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "usage.reset.outcome", outcome: await limits.consumeReset(command.payload.confirmationId) } }); break;
      default: return "not-handled";
    }
    return "handled";
  });
}
