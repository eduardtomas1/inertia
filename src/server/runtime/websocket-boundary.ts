import type { Server } from "node:http";

import WebSocket, { WebSocketServer } from "ws";

import type {
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  AppSnapshot,
  ClientCommand,
} from "../../shared/contracts";
import { RUNTIME_WEBSOCKET_MAX_PAYLOAD_BYTES } from "../../shared/runtime-websocket";
import type { TerminalManager } from "../terminal";
import {
  isAllowedRuntimeOrigin,
  parseRuntimeCommand,
  rejectRuntimeUpgrade,
  sendRuntimeEvent,
} from "../runtime-protocol";
import { parseRuntimeResumeRequest } from "../runtime-sequencing";
import type { IsolatedRunController } from "./reviews/isolated-run-controller";
import {
  MAIN_RUNTIME_CLIENT_AUTHORITY,
  type RuntimeClientAuthority,
} from "./runtime-client-authority";
import type { RuntimeSyncHub } from "./runtime-sync-hub";

export const RUNTIME_WEBSOCKET_LIMITS = {
  maxPayloadBytes: RUNTIME_WEBSOCKET_MAX_PAYLOAD_BYTES,
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
    authority: RuntimeClientAuthority,
  ): Promise<void>;
  consumeDetachedCapability?(requestUrl: string | undefined): {
    conversationId: string;
    clientId: string;
    runtimeRequestUrl: string;
  } | null;
  currentSnapshot(): AppSnapshot;
  beforeFreshSnapshot?(): void;
  approvals(): Iterable<AgentApprovalRequest>;
  inputs(): Iterable<AgentInputRequest>;
  plans(): Iterable<AgentPlan>;
  onDisconnect?(socket: WebSocket): void;
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
  const admissions = new WeakMap<WebSocket, {
    authority: RuntimeClientAuthority;
    resumeRequest: ReturnType<typeof parseRuntimeResumeRequest>;
  }>();
  const detachedSockets = new Map<string, WebSocket>();

  options.server.on("upgrade", (request, socket, head) => {
    if (!isAllowedRuntimeOrigin(request.headers.origin)) {
      return rejectRuntimeUpgrade(socket, 403);
    }
    if (
      options.runtimeSync.connectionCount
      >= RUNTIME_WEBSOCKET_LIMITS.maxClients
    ) {
      return rejectRuntimeUpgrade(socket, 503);
    }
    let authority = MAIN_RUNTIME_CLIENT_AUTHORITY;
    let resumeRequest = parseRuntimeResumeRequest(
      request.url,
      options.websocketPath,
    );
    if (resumeRequest.kind === "invalid") {
      const capability = options.consumeDetachedCapability?.(request.url)
        ?? null;
      if (!capability) return rejectRuntimeUpgrade(socket, 404);
      resumeRequest = parseRuntimeResumeRequest(
        capability.runtimeRequestUrl,
        options.websocketPath,
      );
      if (resumeRequest.kind === "invalid") {
        return rejectRuntimeUpgrade(socket, 404);
      }
      authority = {
        kind: "detached-chat",
        conversationId: capability.conversationId,
        clientId: capability.clientId,
      };
    }
    webSockets.handleUpgrade(
      request,
      socket,
      head,
      (webSocket) => {
        admissions.set(webSocket, { authority, resumeRequest });
        if (authority.kind === "detached-chat") {
          const previous = detachedSockets.get(authority.clientId);
          detachedSockets.set(authority.clientId, webSocket);
          if (previous && previous !== webSocket) previous.terminate();
        }
        webSockets.emit("connection", webSocket, request);
      },
    );
  });

  webSockets.on("connection", (socket) => {
    let inFlightCommands = 0;
    const admission = admissions.get(socket);
    admissions.delete(socket);
    if (!admission) {
      socket.terminate();
      return;
    }
    const { authority, resumeRequest } = admission;
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
        void options.dispatchCommand(
          socket,
          parsed.command,
          authority,
        ).finally(() => {
          inFlightCommands -= 1;
        });
      }
    });
    socket.on("close", () => {
      if (
        authority.kind === "detached-chat"
        && detachedSockets.get(authority.clientId) === socket
      ) detachedSockets.delete(authority.clientId);
      options.onDisconnect?.(socket);
      options.runtimeSync.disconnect(socket);
      options.terminals.disposeOwner(socket);
      options.isolatedRuns.stopOwned(socket);
    });
    socket.on("error", () => {
      // Connection failures are isolated and cleaned up by close.
    });
    // Install every handler before hydration: a client may answer welcome from
    // another process immediately.
    try {
      options.runtimeSync.connect(socket, resumeRequest, {
        beforeFreshSnapshot: options.beforeFreshSnapshot,
        snapshot: options.currentSnapshot,
        approvals: options.approvals(),
        inputs: options.inputs(),
        plans: options.plans(),
      }, authority);
    } catch {
      socket.close(1011, "Runtime synchronization failed.");
    }
  });

  return {
    close: async () => {
      await new Promise<void>((resolve) => {
        webSockets.close(() => resolve());
      });
    },
  };
}
