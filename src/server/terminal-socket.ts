import WebSocket from "ws";

import type { ServerEvent } from "../shared/contracts";

const MAX_BUFFERED_OUTPUT = 1024 * 1024;

function stopSlowSocket(socket: WebSocket): void {
  try {
    socket.terminate();
  } catch {
    // A concurrent close may already have released the transport.
  }
}

export function sendTerminalSocketEvent(
  socket: WebSocket,
  event: ServerEvent,
): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount > MAX_BUFFERED_OUTPUT) {
    stopSlowSocket(socket);
    return false;
  }
  try {
    socket.send(JSON.stringify(event));
    return true;
  } catch {
    stopSlowSocket(socket);
    return false;
  }
}
