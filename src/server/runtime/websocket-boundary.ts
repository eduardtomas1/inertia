import type { Server } from "node:http";

import WebSocket, { WebSocketServer } from "ws";

import type {
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  AppSnapshot,
  ClientCommand,
} from "../../shared/contracts";
import type { TerminalManager } from "../terminal";
import {
  isAllowedRuntimeOrigin,
  parseRuntimeCommand,
  rejectRuntimeUpgrade,
  sendRuntimeEvent,
} from "../runtime-protocol";
import { parseRuntimeResumeRequest } from "../runtime-sequencing";
import type { IsolatedRunController } from "./reviews/isolated-run-controller";
import type { RuntimeSyncHub } from "./runtime-sync-hub";

export const RUNTIME_WEBSOCKET_LIMITS = {
  maxPayloadBytes: 256 * 1024,
  maxClients: 16,
  maxInFlightCommands: 32,
} as const;

export interface RuntimeWebSocketBoundaryOptions {
  server: Server;
  websocketPath: string;
  runtimeSync: RuntimeSyncHub<WebSocket>;
  terminals: TerminalManager;
  isolatedRuns: IsolatedRunController<WebSocket>;
  dispatchCommand(
    socket: WebSocket,
    command: ClientCommand,
  ): Promise<void>;
  currentSnapshot(): AppSnapshot;
  approvals(): Iterable<AgentApprovalRequest>;
  inputs(): Iterable<AgentInputRequest>;
  plans(): Iterable<AgentPlan>;
}

export interface RuntimeWebSocketBoundary {
  close(): Promise<void>;
}

/**
 * Owns the authenticated local WebSocket boundary. Limits and handler ordering
 * stay visible here because they are security and lifecycle invariants, not
 * generic transport configuration.
 */
export function attachRuntimeWebSocketBoundary(
  options: RuntimeWebSocketBoundaryOptions,
): RuntimeWebSocketBoundary {
  const webSockets = new WebSocketServer({
    noServer: true,
    maxPayload: RUNTIME_WEBSOCKET_LIMITS.maxPayloadBytes,
    // This transport is loopback-only. The checked-in benchmark documents why
    // zlib CPU/native-memory overhead currently outweighs reduced TCP bytes.
    perMessageDeflate: false,
  });

  options.server.on("upgrade", (request, socket, head) => {
    if (
      parseRuntimeResumeRequest(
        request.url,
        options.websocketPath,
      ).kind === "invalid"
    ) {
      return rejectRuntimeUpgrade(socket, 404);
    }
    if (!isAllowedRuntimeOrigin(request.headers.origin)) {
      return rejectRuntimeUpgrade(socket, 403);
    }
    if (
      options.runtimeSync.connectionCount
      >= RUNTIME_WEBSOCKET_LIMITS.maxClients
    ) {
      return rejectRuntimeUpgrade(socket, 503);
    }
    webSockets.handleUpgrade(
      request,
      socket,
      head,
      (webSocket) => webSockets.emit("connection", webSocket, request),
    );
  });

  webSockets.on("connection", (socket, request) => {
    let inFlightCommands = 0;
    const resumeRequest = parseRuntimeResumeRequest(
      request.url,
      options.websocketPath,
    );
    socket.on("message", (data, isBinary) => {
      const parsed = parseRuntimeCommand(data, isBinary);
      if (parsed.error) {
        sendRuntimeEvent(socket, parsed.error);
      } else if (parsed.command) {
        if (
          inFlightCommands
          >= RUNTIME_WEBSOCKET_LIMITS.maxInFlightCommands
        ) {
          sendRuntimeEvent(socket, {
            type: "request.error",
            requestId: parsed.command.requestId,
            message: "Too many requests are already running.",
          });
          return;
        }
        inFlightCommands += 1;
        void options.dispatchCommand(socket, parsed.command).finally(() => {
          inFlightCommands -= 1;
        });
      }
    });
    socket.on("close", () => {
      options.runtimeSync.disconnect(socket);
      options.terminals.disposeOwner(socket);
      options.isolatedRuns.stopOwned(socket);
    });
    socket.on("error", () => {
      // Connection failures are isolated and cleaned up by close.
    });
    // Install every handler before hydration: a client may answer welcome from
    // another process immediately.
    options.runtimeSync.connect(socket, resumeRequest, {
      snapshot: options.currentSnapshot,
      approvals: options.approvals(),
      inputs: options.inputs(),
      plans: options.plans(),
    });
  });

  return {
    close: async () => {
      await new Promise<void>((resolve) => {
        webSockets.close(() => resolve());
      });
    },
  };
}
