import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppSnapshot,
  ClientCommand,
  RuntimeSyncCursor,
  ServerEvent,
} from "@shared/contracts";
import {
  RuntimeDetailSubscriptions,
  runtimeResumeUrl,
  RuntimeProjectionSequence,
} from "../utils/runtimeSequencing";
import { MESSAGE_SEND_REQUEST_TIMEOUT_MS } from "@shared/runtime-command-timeouts";
import { serializeRuntimeClientCommand } from "@shared/runtime-websocket";
import {
  deliverDecodedServerEvent,
  notifyConnectionListeners,
  RuntimeCommandError,
  settlePendingConnectionRequest,
  UNREADABLE_RUNTIME_RESPONSE,
  type PendingConnectionRequest,
} from "../utils/connectionMessages";
import { applyConversationShellEvent } from "../utils/runtimeSnapshotProjection";

export type ConnectionStatus = "connecting" | "online" | "offline";

type EventListener = (event: ServerEvent) => void;

export interface InertiaConnection {
  snapshot: AppSnapshot | null;
  runtimeGeneration: string | null;
  status: ConnectionStatus;
  error: string | null;
  clearError: () => void;
  sendCommand: (command: ClientCommand) => Promise<ServerEvent>;
  subscribe: (listener: EventListener) => () => void;
}

function requestTimeoutMs(command: ClientCommand): number {
  switch (command.type) {
    case "message.send":
      // The server enforces one aggregate preparation deadline before it can
      // queue a turn. Keep the socket pending through that boundary and its
      // bounded rollback/attachment cleanup so a retry cannot duplicate work.
      return MESSAGE_SEND_REQUEST_TIMEOUT_MS;
    case "git.pull":
    case "git.push":
    case "git.commit":
    case "git.branch.create":
    case "git.branch.switch":
    case "git.worktree.create":
    case "git.selection.inspect":
    case "git.selection.revert":
    case "git.selection.undo":
    case "checkpoint.revert":
    case "review.selection.ask":
    case "review.summary.generate":
      return 150_000;
    default:
      return 15_000;
  }
}

export function useInertiaConnection(): InertiaConnection {
  const socketRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef(new Map<string, PendingConnectionRequest>());
  const listenersRef = useRef(new Set<EventListener>());
  const projectionRef = useRef(new RuntimeProjectionSequence());
  const detailSubscriptionsRef = useRef(new RuntimeDetailSubscriptions());
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [runtimeGeneration, setRuntimeGeneration] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);

  const rejectPending = useCallback((message: string) => {
    for (const pending of pendingRef.current.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(new RuntimeCommandError(message, "ambiguous"));
    }
    pendingRef.current.clear();
  }, []);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;
    let attempt = 0;
    let forceSnapshot = false;
    let connectInFlight = false;

    const scheduleConnect = (delay: number): void => {
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (disposed || connectInFlight || socketRef.current) return;
      connectInFlight = true;
      setStatus("connecting");

      try {
        if (!window.inertia) {
          throw new Error("The desktop bridge is unavailable. Open Inertia through the desktop app.");
        }

        const { websocketUrl } = await window.inertia.getRuntimeConnection();
        if (disposed) return;

        const projection = projectionRef.current.current();
        const resumeCursor: RuntimeSyncCursor | null = forceSnapshot || !projection
          ? null
          : {
              runtimeGeneration: projection.runtimeGeneration,
              latestSequence: projection.latestSequence,
            };
        forceSnapshot = false;
        const socket = new WebSocket(runtimeResumeUrl(
          websocketUrl,
          resumeCursor,
          detailSubscriptionsRef.current.conversationIds(),
        ));
        socketRef.current = socket;

        socket.addEventListener("open", () => {
          if (disposed || socketRef.current !== socket) return;
          setStatus("connecting");
        });

        socket.addEventListener("message", (message) => {
          if (disposed || socketRef.current !== socket) return;

          deliverDecodedServerEvent(
            message.data,
            (receivedEvent) => {
              let event = receivedEvent;
              const requireAuthoritativeRefresh = (): void => {
                forceSnapshot = true;
                projectionRef.current.reset();
                if (socket.readyState === WebSocket.OPEN) socket.close();
              };

              if (event.type === "server.welcome") {
                const sync = event.sync ?? event.snapshot.sync;
                if (sync) {
                  projectionRef.current.replaceFromSnapshot(sync);
                  setRuntimeGeneration(sync.runtimeGeneration);
                } else {
                  // Compatibility with pre-sequencing local runtimes.
                  projectionRef.current.reset();
                  setRuntimeGeneration(null);
                  setStatus("online");
                }
                setSnapshot(event.snapshot);
              } else if (event.type === "runtime.resumed") {
                if (projectionRef.current.beginResume(event.sync) !== "resume") {
                  requireAuthoritativeRefresh();
                  return;
                }
                setRuntimeGeneration(event.sync.runtimeGeneration);
              } else if (
                event.type === "runtime.event"
                || event.type === "runtime.cursor"
              ) {
                const decision = projectionRef.current.classifyFrame(event.sync);
                if (decision === "generation-mismatch" || decision === "gap") {
                  requireAuthoritativeRefresh();
                  return;
                }
                if (decision === "ignore") return;
                if (event.type === "runtime.cursor") return;
                event = event.event;
                if (event.type === "snapshot.updated") {
                  setSnapshot(event.snapshot);
                } else if (event.type === "conversation.shell.updated") {
                  const shellEvent = event;
                  setSnapshot((current) => current
                    ? applyConversationShellEvent(current, shellEvent)
                    : current);
                }
              } else if (event.type === "runtime.sync.completed") {
                const decision = projectionRef.current.complete(event.sync);
                if (decision === "generation-mismatch" || decision === "gap") {
                  requireAuthoritativeRefresh();
                  return;
                }
                if (decision === "completed") {
                  attempt = 0;
                  setStatus("online");
                  setError(null);
                }
              } else if (event.type === "snapshot.updated") {
                setSnapshot(event.snapshot);
              } else if (event.type === "conversation.shell.updated") {
                const shellEvent = event;
                setSnapshot((current) => current
                  ? applyConversationShellEvent(current, shellEvent)
                  : current);
              }

              settlePendingConnectionRequest(
                event,
                pendingRef.current,
                window.clearTimeout,
              );

              notifyConnectionListeners(event, listenersRef.current);
            },
            () => setError(UNREADABLE_RUNTIME_RESPONSE),
          );
        });

        socket.addEventListener("close", () => {
          if (disposed || socketRef.current !== socket) return;
          socketRef.current = null;
          projectionRef.current.disconnect();
          setStatus("offline");
          rejectPending("The local service disconnected before finishing the request.");
          const delay = forceSnapshot
            ? 0
            : Math.min(8_000, 600 * 2 ** attempt) + Math.round(Math.random() * 250);
          attempt += 1;
          scheduleConnect(delay);
        });

        socket.addEventListener("error", () => {
          if (!disposed && socketRef.current === socket) socket.close();
        });
      } catch (connectionError) {
        if (disposed) return;
        setStatus("offline");
        setError(connectionError instanceof Error ? connectionError.message : "The local service is unavailable.");
        const delay = Math.min(8_000, 600 * 2 ** attempt);
        attempt += 1;
        scheduleConnect(delay);
      } finally {
        connectInFlight = false;
      }
    };

    const stopRuntimeReady = window.inertia?.onRuntimeReady?.(() => {
      attempt = 0;
      scheduleConnect(0);
    });
    void connect();

    return () => {
      disposed = true;
      stopRuntimeReady?.();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
      rejectPending("The Inertia window closed before finishing the request.");
    };
  }, [rejectPending]);

  const sendCommand = useCallback((command: ClientCommand): Promise<ServerEvent> => {
    if (command.type === "conversation.detail.subscription") {
      detailSubscriptionsRef.current.set(
        command.payload.owner,
        command.payload.conversationId,
      );
    }
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new RuntimeCommandError(
        "The local service is reconnecting. Try again in a moment.",
        "not-sent",
      ));
    }

    let serialized: string;
    try {
      serialized = serializeRuntimeClientCommand(command);
    } catch (serializationError) {
      return Promise.reject(
        serializationError instanceof Error
          ? new RuntimeCommandError(serializationError.message, "not-sent")
          : new RuntimeCommandError(
              "The request could not be validated.",
              "not-sent",
            ),
      );
    }

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingRef.current.delete(command.requestId);
        if (socketRef.current === socket) {
          // Delivery is now ambiguous. Drop the resumable cursor and reconnect
          // so the next authoritative snapshot can prove whether the command
          // changed state instead of leaving callers waiting indefinitely.
          projectionRef.current.reset();
          if (socket.readyState === WebSocket.OPEN) socket.close();
        }
        reject(new RuntimeCommandError(
          "The request took too long to complete.",
          "ambiguous",
        ));
      }, requestTimeoutMs(command));

      pendingRef.current.set(command.requestId, { resolve, reject, timeout });
      try {
        socket.send(serialized);
      } catch (sendError) {
        window.clearTimeout(timeout);
        pendingRef.current.delete(command.requestId);
        reject(new RuntimeCommandError(
          sendError instanceof Error
            ? sendError.message
            : "The request could not be sent.",
          "not-sent",
        ));
      }
    });
  }, []);

  const subscribe = useCallback((listener: EventListener) => {
    listenersRef.current.add(listener);
    return () => listenersRef.current.delete(listener);
  }, []);

  return {
    snapshot,
    runtimeGeneration,
    status,
    error,
    clearError: useCallback(() => setError(null), []),
    sendCommand,
    subscribe,
  };
}
