import type { ServerEvent } from "@shared/contracts";

let serverEventParser: Promise<
  (value: unknown) => ServerEvent
> | null = null;
let resolvedServerEventParser: ((value: unknown) => ServerEvent) | null = null;
let pendingAsyncDeliveries = 0;

function loadServerEventParser(): Promise<(value: unknown) => ServerEvent> {
  if (serverEventParser) return serverEventParser;
  const loading = import("@shared/contracts/server-event-schema")
    .then(({ parseServerEvent }) => {
      resolvedServerEventParser = parseServerEvent;
      return parseServerEvent;
    });
  serverEventParser = loading;
  void loading.catch(() => {
    if (serverEventParser === loading) serverEventParser = null;
  });
  return loading;
}

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
    readonly diagnosticId?: string,
  ) {
    super(diagnosticId && /^[0-9a-f-]{36}$/iu.test(diagnosticId) ? `${message} [incident:${diagnosticId}]` : message);
    this.name = "RuntimeCommandError";
  }
}

export function runtimeCommandDelivery(
  error: unknown,
): RuntimeCommandDelivery | null {
  return error instanceof RuntimeCommandError ? error.delivery : null;
}

export function messageSendFailureText(error: unknown): string {
  const detail = error instanceof Error ? error.message : "The message could not be sent.";
  return runtimeCommandDelivery(error) === "ambiguous"
    ? `Delivery could not be confirmed. Check this chat before sending again; the message may already have arrived. ${detail}`
    : detail;
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
  const parse = resolvedServerEventParser ?? await loadServerEventParser();
  return parse(received);
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

export function deliverDecodedServerEventSync(
  data: unknown,
  onEvent: (event: ServerEvent) => void,
  onUnreadable: () => void,
): boolean | Promise<boolean> {
  if (resolvedServerEventParser !== null && pendingAsyncDeliveries === 0) {
    let event: ServerEvent;
    try {
      event = resolvedServerEventParser(JSON.parse(String(data)));
    } catch {
      onUnreadable();
      return false;
    }
    onEvent(event);
    return true;
  }
  pendingAsyncDeliveries += 1;
  return deliverDecodedServerEvent(data, onEvent, onUnreadable).finally(() => {
    pendingAsyncDeliveries -= 1;
  });
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
    pending.reject(new RuntimeCommandError(event.message, event.delivery ?? "rejected", event.diagnosticId));
  } else {
    pending.resolve(event);
  }
  return "settled";
}
