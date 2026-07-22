import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";

import WebSocket, { type RawData } from "ws";

import { clientCommandSchema, type ClientCommand, type ServerEvent } from "../shared/contracts";

export function isAllowedRuntimeOrigin(origin: string | undefined): boolean {
  if (origin === "inertia://bundle") return true;
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
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
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
