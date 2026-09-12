import type WebSocket from "ws";
import type { ServerEvent } from "../shared/contracts";
import { sendRuntimeEvent } from "./runtime-protocol";

export function sendTerminalSocketEvent(socket: WebSocket, event: ServerEvent): boolean {
  // Preserve immediate rejection for terminal ownership/replay. Later write
  // failures close the shared transport through the same runtime policy.
  let admitted = true;
  sendRuntimeEvent(socket, event, (sent) => { admitted = sent; });
  return admitted;
}
