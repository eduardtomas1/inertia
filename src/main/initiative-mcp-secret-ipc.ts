import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { initiativeMcpSecretReference } from "../node/initiative-mcp-secret-reference.js";
import {
  INITIATIVE_MCP_SECRET_REQUEST_INVALID,
  MAX_INITIATIVE_MCP_SECRET_REFERENCES_PER_SERVER,
  MAX_INITIATIVE_MCP_SECRET_SERVERS,
  initiativeMcpServerDestination,
  parseInitiativeMcpSecretStateRequest,
  parseSetInitiativeMcpSecretRequest,
  type InitiativeMcpSecretState,
} from "../shared/initiative-mcp.js";
import { CredentialVaultError, type CredentialVault } from "./credential-vault.js";

export type InitiativeMcpSecretVault = Pick<CredentialVault, "storageState" | "setSecret" | "status">;

export interface InitiativeMcpSecretIpcOptions {
  ipcMain: Pick<IpcMain, "handle">;
  channels: { set: string; state: string };
  /** Main-window trust only: the Initiatives page never runs in a detached chat. */
  assertTrusted(event: IpcMainInvokeEvent, argumentCount: number, expectedArguments: number): void;
  vault(): InitiativeMcpSecretVault | null;
}

const UNAVAILABLE = "Secure credential storage is unavailable on this system.";
const NOT_SAVED = "The secret could not be saved.";
const TOO_MANY = "This initiative already keeps as many MCP secrets as Inertia allows. Remove servers or secrets it no longer uses, then try again.";
/** Initiatives whose secrets this process tracks; a bound on the tracker itself. */
const MAX_TRACKED_INITIATIVES = 256;

/** A refusal that never carries the secret or a vault internal. */
function safeError(error: unknown, fallback: string): Error {
  return new Error(error instanceof CredentialVaultError ? error.message : fallback);
}

/**
 * Bounds what the set path can write: at most eight servers per initiative,
 * and at most 32 references (slot and destination pairs) per server. A
 * reference that no longer holds a secret (the runtime forgot it when a server
 * or slot was removed or moved) stops counting. The tracker lives as long as
 * the main process; the runtime's own limits bound what a saved initiative
 * can refer to.
 */
class SecretReferenceBudget {
  private readonly initiatives = new Map<string, Map<string, Set<string>>>();

  constructor(private readonly vault: () => InitiativeMcpSecretVault | null) {}

  async admit(initiativeId: string, serverId: string, reference: string): Promise<boolean> {
    if (this.fits(initiativeId, serverId, reference)) return true;
    await this.prune(this.initiatives.has(initiativeId) ? [initiativeId] : [...this.initiatives.keys()]);
    return this.fits(initiativeId, serverId, reference);
  }

  record(initiativeId: string, serverId: string, reference: string): void {
    const servers = this.initiatives.get(initiativeId) ?? new Map<string, Set<string>>();
    this.initiatives.set(initiativeId, servers);
    const references = servers.get(serverId) ?? new Set<string>();
    servers.set(serverId, references);
    references.add(reference);
  }

  private fits(initiativeId: string, serverId: string, reference: string): boolean {
    const servers = this.initiatives.get(initiativeId);
    if (!servers) return this.initiatives.size < MAX_TRACKED_INITIATIVES;
    const references = servers.get(serverId);
    if (!references) return servers.size < MAX_INITIATIVE_MCP_SECRET_SERVERS;
    return references.has(reference) || references.size < MAX_INITIATIVE_MCP_SECRET_REFERENCES_PER_SERVER;
  }

  private async prune(initiativeIds: readonly string[]): Promise<void> {
    const vault = this.vault();
    if (!vault) return;
    for (const initiativeId of initiativeIds) {
      const servers = this.initiatives.get(initiativeId);
      if (!servers) continue;
      for (const [serverId, references] of servers) {
        for (const reference of references) {
          if (!(await vault.status(reference)).hasSecret) references.delete(reference);
        }
        if (references.size === 0) servers.delete(serverId);
      }
      if (servers.size === 0) this.initiatives.delete(initiativeId);
    }
  }
}

/**
 * Initiative MCP secrets, mirroring the backend credential path: the renderer
 * sends a value once, main stores it in the vault under the reference derived
 * from the initiative, the server, the slot and the server's destination, and
 * only "is a secret set" answers ever go back. The runtime resolves the same
 * derived reference through the credential broker when a provider run starts.
 */
export function registerInitiativeMcpSecretIpc(options: InitiativeMcpSecretIpcOptions): void {
  const budget = new SecretReferenceBudget(options.vault);
  // Writes run one at a time so the budget check and the write cannot interleave.
  let writes: Promise<unknown> = Promise.resolve();
  options.ipcMain.handle(options.channels.set, async (event, ...args) => {
    options.assertTrusted(event, args.length, 1);
    const parsed = parseSetInitiativeMcpSecretRequest(args[0]);
    if (!parsed.ok) throw new Error(parsed.message);
    const { request } = parsed;
    const vault = options.vault();
    if (!vault) throw new Error(UNAVAILABLE);
    const reference = initiativeMcpSecretReference(
      request.initiativeId,
      request.serverId,
      request.slot,
      initiativeMcpServerDestination(request),
    );
    const write = writes.then(async () => {
      let admitted: boolean;
      try {
        admitted = await budget.admit(request.initiativeId, request.serverId, reference);
      } catch (error) {
        throw safeError(error, UNAVAILABLE);
      }
      if (!admitted) throw new Error(TOO_MANY);
      try {
        const status = await vault.setSecret(reference, request.value);
        budget.record(request.initiativeId, request.serverId, reference);
        return status;
      } catch (error) {
        throw safeError(error, NOT_SAVED);
      }
    });
    writes = write.catch(() => undefined);
    const status = await write;
    return {
      slots: { [request.slot]: status.hasSecret },
      storageAvailable: true,
    } satisfies InitiativeMcpSecretState;
  });
  options.ipcMain.handle(options.channels.state, async (event, ...args) => {
    options.assertTrusted(event, args.length, 1);
    const request = parseInitiativeMcpSecretStateRequest(args[0]);
    if (!request) throw new Error(INITIATIVE_MCP_SECRET_REQUEST_INVALID);
    const vault = options.vault();
    if (!vault) throw new Error(UNAVAILABLE);
    const destination = initiativeMcpServerDestination(request);
    try {
      const storage = await vault.storageState();
      const slots: Record<string, boolean> = {};
      for (const slot of request.slots) {
        const reference = initiativeMcpSecretReference(request.initiativeId, request.serverId, slot, destination);
        slots[slot] = (await vault.status(reference)).hasSecret;
      }
      return { slots, storageAvailable: storage.available } satisfies InitiativeMcpSecretState;
    } catch (error) {
      throw safeError(error, UNAVAILABLE);
    }
  });
}
