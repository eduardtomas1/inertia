import { createHash } from "node:crypto";

import { isInitiativeMcpSecretSlot } from "../shared/initiative-mcp.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** Larger than any destination a valid server can have (32 arguments and 32 variables). */
const MAX_DESTINATION_CHARS = 512 * 1024;

/**
 * Node-only derivation shared by the trusted Electron main process, which
 * stores an initiative MCP secret, and the utility runtime, which resolves it
 * when a provider run starts. The reference is derived from the initiative,
 * the server, the entry's slot and the server's destination (its URL, or its
 * command, arguments and plain variables; see
 * `initiativeMcpServerDestination`) and is never stored, so an entry can only
 * reach the secret entered for exactly that place: a server whose destination
 * changes has no secret until one is entered again. It is not credential
 * material and is never sent to the renderer.
 */
export function initiativeMcpSecretReference(
  initiativeId: string,
  serverId: string,
  slot: string,
  destination: string,
): string {
  if (
    !UUID.test(initiativeId)
    || !UUID.test(serverId)
    || !isInitiativeMcpSecretSlot(slot)
    || typeof destination !== "string"
    || destination.length === 0
    || destination.length > MAX_DESTINATION_CHARS
  ) {
    throw new Error("The initiative MCP secret slot is invalid.");
  }
  const digest = createHash("sha256")
    .update(`initiative-mcp\0${initiativeId.toLowerCase()}\0${serverId.toLowerCase()}\0${slot}\0`)
    .update(destination, "utf8")
    .digest("hex");
  return `secret:mcp:${digest}`;
}
