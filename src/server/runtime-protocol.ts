import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";

import WebSocket, { type RawData } from "ws";

import { clientCommandSchema, type ClientCommand, type ServerEvent } from "../shared/contracts";

/**
 * A temporary backlog above this watermark is expected when hydrating a long
 * conversation. It becomes a transport failure only when it stops draining.
 */
export const MAX_BUFFERED_RUNTIME_EVENT_BYTES = 1024 * 1024;
export const MAX_QUEUED_RUNTIME_EVENT_BYTES = 64 * 1024 * 1024;
export const MAX_RUNTIME_EVENT_STALL_MS = 5_000;
const RUNTIME_EVENT_BACKPRESSURE_POLL_MS = 250;

interface RuntimeEventBackpressureState {
  lastBufferedAmount: number;
  lastProgressAt: number;
  timer: NodeJS.Timeout | null;
}

const runtimeEventBackpressure = new WeakMap<
  WebSocket,
  RuntimeEventBackpressureState
>();

function clearRuntimeEventBackpressure(socket: WebSocket): void {
  const state = runtimeEventBackpressure.get(socket);
  if (state?.timer) clearTimeout(state.timer);
  runtimeEventBackpressure.delete(socket);
}

function terminateSocket(socket: WebSocket): void {
  clearRuntimeEventBackpressure(socket);
  try { socket.terminate(); } catch { /* The transport is already unusable. */ }
}

function observeRuntimeEventBackpressure(socket: WebSocket): void {
  if (
    socket.readyState !== WebSocket.OPEN
    || socket.bufferedAmount <= MAX_BUFFERED_RUNTIME_EVENT_BYTES
  ) {
    clearRuntimeEventBackpressure(socket);
    return;
  }

  const now = Date.now();
  const state = runtimeEventBackpressure.get(socket) ?? {
    lastBufferedAmount: socket.bufferedAmount,
    lastProgressAt: now,
    timer: null,
  };
  runtimeEventBackpressure.set(socket, state);
  if (state.timer) return;

  state.timer = setTimeout(() => {
    state.timer = null;
    if (socket.readyState !== WebSocket.OPEN) {
      clearRuntimeEventBackpressure(socket);
      return;
    }

    const bufferedAmount = socket.bufferedAmount;
    if (bufferedAmount <= MAX_BUFFERED_RUNTIME_EVENT_BYTES) {
      clearRuntimeEventBackpressure(socket);
      return;
    }
    if (bufferedAmount < state.lastBufferedAmount) {
      state.lastProgressAt = Date.now();
    }
    state.lastBufferedAmount = bufferedAmount;
    if (Date.now() - state.lastProgressAt >= MAX_RUNTIME_EVENT_STALL_MS) {
      terminateSocket(socket);
      return;
    }
    observeRuntimeEventBackpressure(socket);
  }, RUNTIME_EVENT_BACKPRESSURE_POLL_MS);
  state.timer.unref();
}

export function isAllowedRuntimeOrigin(origin: string | undefined): boolean {
  if (origin === "inertia://bundle" || origin === "inertia-canary://bundle") return true;
  if (origin === undefined || origin === "null" || origin === "file://") return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

export function rejectRuntimeUpgrade(socket: Duplex, status: 403 | 404 | 503): void {
  const label = status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "Service Unavailable";
  socket.end(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function requestIdFrom(value: unknown): string {
  return typeof value === "object" && value !== null && "requestId" in value && typeof value.requestId === "string"
    ? value.requestId
    : randomUUID();
}

export function sendRuntimeEvent(socket: WebSocket, event: ServerEvent): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  let serialized: string;
  try {
    serialized = JSON.stringify(event);
  } catch {
    terminateSocket(socket);
    return;
  }
  const eventBytes = Buffer.byteLength(serialized, "utf8");
  if (
    eventBytes > MAX_QUEUED_RUNTIME_EVENT_BYTES
    || socket.bufferedAmount
      > MAX_QUEUED_RUNTIME_EVENT_BYTES - eventBytes
  ) {
    terminateSocket(socket);
    return;
  }
  try {
    socket.send(serialized, (error) => {
      if (error) {
        terminateSocket(socket);
        return;
      }
      const state = runtimeEventBackpressure.get(socket);
      if (state) {
        state.lastBufferedAmount = socket.bufferedAmount;
        state.lastProgressAt = Date.now();
      }
      observeRuntimeEventBackpressure(socket);
    });
    observeRuntimeEventBackpressure(socket);
  } catch {
    terminateSocket(socket);
  }
}

export function parseRuntimeCommand(data: RawData, isBinary: boolean): { command?: ClientCommand; error?: ServerEvent } {
  if (isBinary) return { error: { type: "request.error", requestId: randomUUID(), message: "Binary commands are not supported." } };
  const text = Buffer.isBuffer(data)
    ? data.toString("utf8")
    : data instanceof ArrayBuffer
      ? Buffer.from(data).toString("utf8")
      : Buffer.concat(data).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: { type: "request.error", requestId: randomUUID(), message: "Command must be valid JSON." } };
  }
  const result = clientCommandSchema.safeParse(value);
  return result.success
    ? { command: result.data }
    : { error: { type: "request.error", requestId: requestIdFrom(value), message: "Invalid command." } };
}
