import type { ServerEvent } from "@shared/contracts";

export const UNREADABLE_RUNTIME_RESPONSE =
  "Inertia received an unreadable response from its local service.";

export type RuntimeCommandDelivery =
  | "not-sent"
  | "rejected"
  | "ambiguous";

export class RuntimeCommandError extends Error {
  constructor(
    message: string,
    readonly delivery: RuntimeCommandDelivery,
  ) {
    super(message);
    this.name = "RuntimeCommandError";
  }
}

export function runtimeCommandDelivery(
  error: unknown,
): RuntimeCommandDelivery | null {
  return error instanceof RuntimeCommandError ? error.delivery : null;
}

export interface PendingConnectionRequest {
  resolve: (event: ServerEvent) => void;
  reject: (error: Error) => void;
  timeout: number;
}

function isServerEvent(value: unknown): value is ServerEvent {
  return Boolean(
    value
    && typeof value === "object"
    && "type" in value
    && typeof value.type === "string",
  );
}

export function decodeServerEventMessage(data: unknown): ServerEvent {
  const received: unknown = JSON.parse(String(data));
  if (!isServerEvent(received)) throw new Error("Malformed server event");
  return received;
}

export function deliverDecodedServerEvent(
  data: unknown,
  onEvent: (event: ServerEvent) => void,
  onUnreadable: () => void,
): boolean {
  let event: ServerEvent;
  try {
    event = decodeServerEventMessage(data);
  } catch {
    onUnreadable();
    return false;
  }
  // Deliberately outside the decode catch: projection or subscriber failures
  // must never be relabelled as malformed transport data.
  onEvent(event);
  return true;
}

export function notifyConnectionListeners(
  event: ServerEvent,
  listeners: Iterable<(event: ServerEvent) => void>,
  onListenerError: (error: unknown) => void = console.error,
): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      onListenerError(error);
    }
  }
}

export function settlePendingConnectionRequest(
  event: ServerEvent,
  pendingRequests: Map<string, PendingConnectionRequest>,
  clearPendingTimeout: (timeout: number) => void,
): boolean {
  if (
    event.type !== "request.error"
    && event.type !== "request.ok"
    && event.type !== "request.result"
    && event.type !== "terminal.created"
  ) {
    return false;
  }
  const pending = pendingRequests.get(event.requestId);
  if (!pending) return false;
  clearPendingTimeout(pending.timeout);
  pendingRequests.delete(event.requestId);
  if (event.type === "request.error") {
    pending.reject(new RuntimeCommandError(event.message, "rejected"));
  } else {
    pending.resolve(event);
  }
  return true;
}
