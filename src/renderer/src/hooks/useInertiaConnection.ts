import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSnapshot, ClientCommand, ServerEvent } from "@shared/contracts";

export type ConnectionStatus = "connecting" | "online" | "offline";

type PendingRequest = {
  resolve: (event: ServerEvent) => void;
  reject: (error: Error) => void;
  timeout: number;
};

type EventListener = (event: ServerEvent) => void;

export interface InertiaConnection {
  snapshot: AppSnapshot | null;
  status: ConnectionStatus;
  error: string | null;
  clearError: () => void;
  sendCommand: (command: ClientCommand) => Promise<ServerEvent>;
  subscribe: (listener: EventListener) => () => void;
}

function isServerEvent(value: unknown): value is ServerEvent {
  return Boolean(value && typeof value === "object" && "type" in value && typeof value.type === "string");
}

export function useInertiaConnection(): InertiaConnection {
  const socketRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef(new Map<string, PendingRequest>());
  const listenersRef = useRef(new Set<EventListener>());
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [error, setError] = useState<string | null>(null);

  const rejectPending = useCallback((message: string) => {
    for (const pending of pendingRef.current.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    pendingRef.current.clear();
  }, []);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;
    let attempt = 0;

    const connect = async () => {
      if (disposed) return;
      setStatus("connecting");

      try {
        if (!window.inertia) {
          throw new Error("The desktop bridge is unavailable. Open Inertia through the desktop app.");
        }

        const { websocketUrl } = await window.inertia.getRuntimeConnection();
        if (disposed) return;

        const socket = new WebSocket(websocketUrl);
        socketRef.current = socket;

        socket.addEventListener("open", () => {
          if (disposed || socketRef.current !== socket) return;
          attempt = 0;
          setStatus("online");
          setError(null);
        });

        socket.addEventListener("message", (message) => {
          if (disposed || socketRef.current !== socket) return;

          try {
            const event: unknown = JSON.parse(String(message.data));
            if (!isServerEvent(event)) throw new Error("Malformed server event");

            if (event.type === "server.welcome" || event.type === "snapshot.updated") {
              setSnapshot(event.snapshot);
            }

            if (
              event.type === "request.error" ||
              event.type === "request.ok" ||
              event.type === "request.result" ||
              event.type === "terminal.created"
            ) {
              const pending = pendingRef.current.get(event.requestId);
              if (pending) {
                window.clearTimeout(pending.timeout);
                pendingRef.current.delete(event.requestId);
                if (event.type === "request.error") {
                  const requestError = new Error(event.message);
                  setError(event.message);
                  pending.reject(requestError);
                } else {
                  pending.resolve(event);
                }
              }
            }

            for (const listener of listenersRef.current) listener(event);
          } catch {
            setError("Inertia received an unreadable response from its local service.");
          }
        });

        socket.addEventListener("close", () => {
          if (disposed || socketRef.current !== socket) return;
          socketRef.current = null;
          setStatus("offline");
          rejectPending("The local service disconnected before finishing the request.");
          const delay = Math.min(8_000, 600 * 2 ** attempt) + Math.round(Math.random() * 250);
          attempt += 1;
          reconnectTimer = window.setTimeout(connect, delay);
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
        reconnectTimer = window.setTimeout(connect, delay);
      }
    };

    void connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
      rejectPending("The Inertia window closed before finishing the request.");
    };
  }, [rejectPending]);

  const sendCommand = useCallback((command: ClientCommand): Promise<ServerEvent> => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("The local service is reconnecting. Try again in a moment."));
    }

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingRef.current.delete(command.requestId);
        reject(new Error("The request took too long to complete."));
      }, 15_000);

      pendingRef.current.set(command.requestId, { resolve, reject, timeout });
      try {
        socket.send(JSON.stringify(command));
      } catch (sendError) {
        window.clearTimeout(timeout);
        pendingRef.current.delete(command.requestId);
        reject(sendError instanceof Error ? sendError : new Error("The request could not be sent."));
      }
    });
  }, []);

  const subscribe = useCallback((listener: EventListener) => {
    listenersRef.current.add(listener);
    return () => listenersRef.current.delete(listener);
  }, []);

  return {
    snapshot,
    status,
    error,
    clearError: useCallback(() => setError(null), []),
    sendCommand,
    subscribe,
  };
}
