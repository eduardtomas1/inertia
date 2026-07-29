import type { ClientCommand } from "./contracts/client-command";

export const RUNTIME_WEBSOCKET_MAX_PAYLOAD_BYTES = 256 * 1024;

const oversizedCommandMessage =
  "The request is too large to send. Reduce the file content and try again.";

/**
 * Serialize before registering or sending a request so JSON escaping cannot
 * turn a schema-valid command into an oversized WebSocket payload.
 */
export function serializeRuntimeClientCommand(
  command: ClientCommand,
): string {
  const serialized = JSON.stringify(command);
  if (
    new TextEncoder().encode(serialized).byteLength
    > RUNTIME_WEBSOCKET_MAX_PAYLOAD_BYTES
  ) {
    throw new Error(oversizedCommandMessage);
  }
  return serialized;
}
