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
import {
  publishesWorkspaceGitCompletion,
  runtimeCommandPolicy,
} from "../utils/runtimeCommandPolicy";
import type { DatabaseRecoveryStartupNotice } from "@shared/desktop";
import { markTestStreamingStage } from "../utils/testStreamingTrace";

export type ConnectionStatus = "connecting" | "online" | "offline";

type EventListener = (event: ServerEvent) => void;

export interface InertiaConnection {
  snapshot: AppSnapshot | null;
  runtimeGeneration: string | null;
  status: ConnectionStatus;
  error: string | null;
  databaseRecoveryNotice: DatabaseRecoveryStartupNotice | null;
  dismissDatabaseRecoveryNotice: () => void;
  clearError: () => void;
  sendCommand: (command: ClientCommand) => Promise<ServerEvent>;
  subscribe: (listener: EventListener) => () => void;
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
  const [databaseRecoveryNotice, setDatabaseRecoveryNotice] =
    useState<DatabaseRecoveryStartupNotice | null>(null);

  const rejectPending = useCallback((message: string) => {
    for (const pending of pendingRef.current.values()) {
      window.clearTimeout(pending.timeout);
      if (!pending.timedOut) {
        pending.reject(new RuntimeCommandError(message, "ambiguous"));
      }
    }
    pendingRef.current.clear();
  }, []);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;
    let attempt = 0;
    let forceSnapshot = false;
    let connectInFlight = false;
    let immediateReconnectPending = false;

    const scheduleConnect = (delay: number): void => {
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, delay);
    };

    const requestImmediateConnect = (): void => {
      if (connectInFlight) {
        immediateReconnectPending = true;
        return;
      }
      scheduleConnect(0);
    };

    const connect = async () => {
      if (disposed || connectInFlight || socketRef.current) return;
      connectInFlight = true;
      setStatus("connecting");

      try {
        if (!window.inertia) {
          throw new Error("The desktop bridge is unavailable. Open Inertia through the desktop app.");
        }

        const runtimeConnection = await window.inertia.getRuntimeConnection();
        if ("unavailable" in runtimeConnection) {
          setStatus("offline");
          setError(runtimeConnection.message);
          if (runtimeConnection.retryable) {
            const delay = Math.min(8_000, 600 * 2 ** attempt);
            attempt += 1;
            scheduleConnect(delay);
          }
          return;
        }
        const { websocketUrl, databaseRecoveryNotice: startupNotice } =
          runtimeConnection;
        if (disposed) return;
        if (startupNotice) setDatabaseRecoveryNotice(startupNotice);

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
        let acceptingFrames = true;
        let mutationReconciliationPending = false;
        socketRef.current = socket;

        const condemnSocket = (): void => {
          acceptingFrames = false;
          if (
            socket.readyState === WebSocket.CONNECTING
            || socket.readyState === WebSocket.OPEN
          ) socket.close();
        };

        socket.addEventListener("open", () => {
          if (disposed || socketRef.current !== socket || !acceptingFrames) return;
          setStatus("connecting");
        });

        socket.addEventListener("message", (message) => {
          if (disposed || socketRef.current !== socket || !acceptingFrames) return;

          void deliverDecodedServerEvent(
            message.data,
            (receivedEvent) => {
              if (
                disposed
                || socketRef.current !== socket
                || !acceptingFrames
              ) return;
              if (
                receivedEvent.type === "runtime.event"
                && receivedEvent.event.type === "agent.text"
              ) {
                markTestStreamingStage("renderer-websocket-message-received");
              }
              let event = receivedEvent;
              const requireAuthoritativeRefresh = (): void => {
                forceSnapshot = true;
                projectionRef.current.reset();
                condemnSocket();
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

              if (event.type === "workspace.git.invalidated") {
                const pending = pendingRef.current.get(event.requestId);
                if (pending) pending.authoritativePublicationReceived = true;
              }

              const settlement = settlePendingConnectionRequest(
                event,
                pendingRef.current,
                window.clearTimeout,
              );
              if (settlement === "late") {
                // The caller deadline remains truthful, but a mutation that
                // settles afterward may have changed request-driven state
                // that has no runtime event (for example, the current Git
                // branch). Rehydrate only after that ambiguity is confirmed;
                // an ordinary timeout alone is not a transport failure.
                mutationReconciliationPending = true;
              }
              if (
                mutationReconciliationPending
                && ![...pendingRef.current.values()].some(
                  ({ timeoutDelivery }) => timeoutDelivery === "ambiguous",
                )
              ) {
                mutationReconciliationPending = false;
                requireAuthoritativeRefresh();
              }

              notifyConnectionListeners(event, listenersRef.current);
            },
            () => {
              if (
                !disposed
                && socketRef.current === socket
                && acceptingFrames
              ) {
                setError(UNREADABLE_RUNTIME_RESPONSE);
                condemnSocket();
              }
            },
          ).catch((error: unknown) => {
            if (
              disposed
              || socketRef.current !== socket
              || !acceptingFrames
            ) return;
            console.error(error);
            setError("Inertia could not apply a response from its local service.");
            condemnSocket();
          });
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
          if (!disposed && socketRef.current === socket) condemnSocket();
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
        if (!disposed && immediateReconnectPending) {
          immediateReconnectPending = false;
          scheduleConnect(0);
        }
      }
    };

    const stopRuntimeReady = window.inertia?.onRuntimeReady?.(() => {
      attempt = 0;
      requestImmediateConnect();
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
      const policy = runtimeCommandPolicy(command.type);
      const timeout = window.setTimeout(() => {
        const pending = pendingRef.current.get(command.requestId);
        if (!pending) return;
        if (policy.timeoutDelivery === "ambiguous") {
          pending.timedOut = true;
        } else {
          pendingRef.current.delete(command.requestId);
        }
        // A command deadline is not evidence that the shared transport failed.
        // Keep the socket alive; an ambiguously delivered command remains
        // registered so its eventual settlement can trigger reconciliation.
        reject(new RuntimeCommandError(
          "The request took too long to complete.",
          policy.timeoutDelivery,
        ));
      }, policy.timeoutMs);

      pendingRef.current.set(command.requestId, {
        resolve,
        reject,
        timeout,
        timeoutDelivery: policy.timeoutDelivery,
        awaitsWorkspaceGitPublication: publishesWorkspaceGitCompletion(
          command.type,
        ),
      });
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
    databaseRecoveryNotice,
    dismissDatabaseRecoveryNotice: useCallback(
      () => setDatabaseRecoveryNotice(null),
      [],
    ),
    clearError: useCallback(() => setError(null), []),
    sendCommand,
    subscribe,
  };
}
