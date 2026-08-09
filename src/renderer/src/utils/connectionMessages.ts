import type { ServerEvent } from "@shared/contracts";

const serverEventParser = import("@shared/contracts/server-event-schema")
  .then(({ parseServerEvent }) => parseServerEvent);

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
  timedOut?: boolean;
  authoritativePublicationReceived?: boolean;
  awaitsWorkspaceGitPublication?: boolean;
  timeoutDelivery: Exclude<RuntimeCommandDelivery, "not-sent">;
}

export type PendingConnectionSettlement =
  | "settled"
  | "late"
  | "late-awaiting-publication"
  | "late-published"
  | null;

export async function decodeServerEventMessage(data: unknown): Promise<ServerEvent> {
  const received: unknown = JSON.parse(String(data));
  return (await serverEventParser)(received);
}

export async function deliverDecodedServerEvent(
  data: unknown,
  onEvent: (event: ServerEvent) => void,
  onUnreadable: () => void,
): Promise<boolean> {
  let event: ServerEvent;
  try {
    event = await decodeServerEventMessage(data);
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
): PendingConnectionSettlement {
  if (
    event.type !== "request.error"
    && event.type !== "request.ok"
    && event.type !== "request.result"
    && event.type !== "terminal.created"
  ) {
    return null;
  }
  const pending = pendingRequests.get(event.requestId);
  if (!pending) return null;
  clearPendingTimeout(pending.timeout);
  pendingRequests.delete(event.requestId);
  if (pending.timedOut) {
    if (pending.authoritativePublicationReceived) return "late-published";
    if (pending.awaitsWorkspaceGitPublication) {
      return "late-awaiting-publication";
    }
    return "late";
  }
  if (event.type === "request.error") {
    pending.reject(new RuntimeCommandError(event.message, "rejected"));
  } else {
    pending.resolve(event);
  }
  return "settled";
}
