import {
  isPrivateConnectUuid,
  privateConnectResponseSchema,
  type PrivateConnectRequest,
  type PrivateConnectResponse,
} from "../../../shared/private-connect/protocol";

export interface PairingInvitation {
  protocolVersion: 1;
  hostId: string;
  invitationId: string;
  pairingSecret: string;
  createdAt: string;
  expiresAt: string;
}

export function parsePairingFragment(fragment: string | null): PairingInvitation | null {
  if (!fragment?.startsWith("#pair=")) return null;
  const encoded = fragment.slice(6);
  if (!encoded || encoded.length > 8_192 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return null;
  try {
    const json = atob(encoded.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(encoded.length / 4) * 4, "="));
    const value = JSON.parse(json) as unknown;
    if (!plainObject(value)
      || value.protocolVersion !== 1
      || typeof value.hostId !== "string"
      || typeof value.invitationId !== "string"
      || typeof value.pairingSecret !== "string"
      || typeof value.createdAt !== "string"
      || typeof value.expiresAt !== "string") return null;
    return value as unknown as PairingInvitation;
  } catch {
    return null;
  }
}

export function browserDeviceId(): string {
  const key = "inertia-private-connect-device-id";
  const existing = window.localStorage.getItem(key);
  if (isPrivateConnectUuid(existing)) return existing;
  const value = crypto.randomUUID();
  window.localStorage.setItem(key, value);
  return value;
}

export async function jsonRequest<T>(path: string, body: unknown, csrf?: string): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-Inertia-Private-Connect-CSRF": csrf } : {}),
    },
    body: JSON.stringify(body),
  });
  const value = await response.json() as T & { message?: string };
  if (!response.ok) {
    const error = new Error(value.message ?? "Private Connect request failed.") as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return value;
}

export async function apiRequest(request: PrivateConnectRequest, csrf: string): Promise<PrivateConnectResponse> {
  return await jsonRequest<PrivateConnectResponse>("/api/request", request, csrf);
}

export interface PrivateConnectSocket {
  request(request: PrivateConnectRequest): Promise<PrivateConnectResponse>;
  onClose(listener: (code: number) => void): () => void;
  close(): void;
}

const PRIVATE_CONNECT_SOCKET_FAILURE = "private-connect-websocket";

function socketFailure(message: string): Error {
  return Object.assign(new Error(message), {
    privateConnectTransport: PRIVATE_CONNECT_SOCKET_FAILURE,
  });
}

export async function connectPrivateConnectSocket(csrf: string): Promise<PrivateConnectSocket> {
  const ticket = await jsonRequest<{ ticket?: string }>("/api/session/ws-ticket", {}, csrf);
  if (typeof ticket.ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(ticket.ticket)) {
    throw new Error("Private Connect did not return a valid live-connection ticket.");
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}/api/ws?ticket=${encodeURIComponent(ticket.ticket)}`);
  const pending = new Map<string, { resolve(response: PrivateConnectResponse): void; reject(error: Error): void; timer: number }>();
  const closeListeners = new Set<(code: number) => void>();
  let opened = false;
  let openingResolve: (() => void) | null = null;
  let openingReject: ((error: Error) => void) | null = null;
  const opening = new Promise<void>((resolve, reject) => {
    openingResolve = resolve;
    openingReject = reject;
  });
  const failPending = (message: string): void => {
    const error = socketFailure(message);
    for (const [requestId, request] of pending) {
      window.clearTimeout(request.timer);
      pending.delete(requestId);
      request.reject(error);
    }
  };
  socket.onopen = () => {
    opened = true;
    openingResolve?.();
    openingResolve = null;
    openingReject = null;
  };
  socket.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    let value: unknown;
    try { value = JSON.parse(event.data) as unknown; } catch { return; }
    const parsed = privateConnectResponseSchema.safeParse(value);
    if (!parsed.success) return;
    const request = pending.get(parsed.data.requestId);
    if (!request) return;
    pending.delete(parsed.data.requestId);
    window.clearTimeout(request.timer);
    request.resolve(parsed.data);
  };
  socket.onerror = () => {
    if (!opened) openingReject?.(socketFailure("Private Connect could not open a live connection."));
    failPending("The Private Connect live connection failed.");
  };
  socket.onclose = (event) => {
    if (!opened) openingReject?.(socketFailure("Private Connect could not open a live connection."));
    failPending("The Private Connect live connection closed.");
    for (const listener of closeListeners) listener(event.code);
    closeListeners.clear();
  };
  try {
    await opening;
  } catch (error) {
    socket.close();
    throw error;
  }
  return {
    request: (request) => {
      if (socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(socketFailure("The Private Connect live connection is not open."));
      }
      return new Promise<PrivateConnectResponse>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pending.delete(request.requestId);
          reject(socketFailure("The Private Connect live request timed out."));
        }, 15_000);
        pending.set(request.requestId, { resolve, reject, timer });
        try {
          socket.send(JSON.stringify(request));
        } catch {
          window.clearTimeout(timer);
          pending.delete(request.requestId);
          reject(socketFailure("The Private Connect live request could not be sent."));
        }
      });
    },
    onClose: (listener) => {
      closeListeners.add(listener);
      return () => { closeListeners.delete(listener); };
    },
    close: () => {
      failPending("The Private Connect live connection closed.");
      socket.close(1000, "Private Connect client closed");
    },
  };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
