import { initiativeMcpSecretReference } from "../../node/initiative-mcp-secret-reference";
import {
  initiativeMcpRouteSupported,
  initiativeMcpSecretRedactionValues,
  initiativeMcpSecretSlot,
  initiativeMcpSecretSlots,
  initiativeMcpSecretValueProblem,
  initiativeMcpServerDestination,
  isSecretInitiativeMcpEntry,
  type InitiativeMcpEntry,
  type InitiativeMcpSecretSlot,
  type InitiativeMcpServer,
} from "../../shared/initiative-mcp";
import type { Conversation } from "../../shared/contracts";
import type { RuntimeStore } from "../database";
import type { InitiativeMcpPendingForgets } from "./initiative-mcp-pending-forgets";
import type {
  ProviderBackendLaunchContext,
  ProviderInitiativeMcpPlan,
  ProviderMcpNameValue,
  ProviderMcpServerInput,
  ProviderMcpServerResolution,
} from "../provider/contracts";

/** The part of the runtime credential broker initiative MCP secrets use. */
export interface InitiativeMcpSecretBroker {
  resolve(secretReference: string, signal?: AbortSignal): Promise<string | null>;
  forget(secretReference: string, signal?: AbortSignal): Promise<boolean>;
}

/**
 * The initiative MCP servers a turn receives, before their secrets are
 * resolved: only for a member chat of an initiative that is not archived, only
 * its enabled servers, and only on a route that takes them.
 */
export function initiativeMcpServerPlan(
  store: Pick<RuntimeStore, "initiatives">,
  conversation: Pick<Conversation, "initiativeId">,
  harnessId: string,
): ProviderInitiativeMcpPlan | undefined {
  if (!conversation.initiativeId || !initiativeMcpRouteSupported(harnessId)) return undefined;
  const initiative = store.initiatives.get(conversation.initiativeId);
  if (!initiative || initiative.status === "archived") return undefined;
  const servers = initiative.preferences.mcpServers.filter(({ enabled }) => enabled);
  return servers.length > 0 ? { initiativeId: initiative.id, servers } : undefined;
}

type EntryResolution =
  | { ok: true; entries: ProviderMcpNameValue[] }
  | { ok: false; reason: string };

async function resolveEntries(
  initiativeId: string,
  server: InitiativeMcpServer,
  kind: "header" | "env",
  entries: readonly InitiativeMcpEntry[],
  broker: InitiativeMcpSecretBroker | undefined,
  secrets: string[],
  signal: AbortSignal,
): Promise<EntryResolution> {
  const resolved: ProviderMcpNameValue[] = [];
  const destination = initiativeMcpServerDestination(server);
  for (const entry of entries) {
    if (!isSecretInitiativeMcpEntry(entry)) {
      resolved.push({ name: entry.name, value: entry.value });
      continue;
    }
    if (!broker) return { ok: false, reason: "Secure credential storage is unavailable." };
    let value: string | null;
    try {
      value = await broker.resolve(
        initiativeMcpSecretReference(initiativeId, server.id, initiativeMcpSecretSlot(kind, entry.name), destination),
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      return { ok: false, reason: "Secure credential storage is unavailable." };
    }
    if (value === null) {
      return { ok: false, reason: `The secret “${entry.name}” is not set. Set it on the Initiative page.` };
    }
    // A value saved before the current rules (too short to redact safely, for
    // example) is never sent: it must be entered again.
    if (initiativeMcpSecretValueProblem(value) !== null) {
      return { ok: false, reason: `The secret “${entry.name}” must be entered again on the Initiative page.` };
    }
    secrets.push(...initiativeMcpSecretRedactionValues(value));
    resolved.push({ name: entry.name, value, secret: true });
  }
  return { ok: true, entries: resolved };
}

/**
 * Resolves a turn's initiative MCP servers just before its provider starts.
 * Secrets are read through the credential broker into memory and returned
 * only in the resolution, which the launch step places in the harness's own
 * copy of the request. A server whose secret is missing, or whose secrets
 * cannot be read, is left out with a reason that never contains a value.
 */
export function createInitiativeMcpResolver(
  broker: InitiativeMcpSecretBroker | undefined,
): (plan: ProviderInitiativeMcpPlan, context: ProviderBackendLaunchContext) => Promise<ProviderMcpServerResolution> {
  return async (plan, { signal }) => {
    const servers: ProviderMcpServerInput[] = [];
    const secrets: string[] = [];
    const omitted: ProviderMcpServerResolution["omitted"] = [];
    for (const server of plan.servers) {
      if (!server.enabled) continue;
      const transport = server.transport;
      const resolution = transport.kind === "http"
        ? await resolveEntries(plan.initiativeId, server, "header", transport.headers, broker, secrets, signal)
        : await resolveEntries(plan.initiativeId, server, "env", transport.env, broker, secrets, signal);
      if (!resolution.ok) {
        omitted.push({ name: server.name, reason: resolution.reason });
        continue;
      }
      servers.push(transport.kind === "http"
        ? { name: server.name, transport: "http", url: transport.url, headers: resolution.entries }
        : {
            name: server.name,
            transport: "stdio",
            command: transport.command,
            args: [...transport.args],
            env: resolution.entries,
          });
    }
    return { servers, secrets, omitted };
  };
}

export function initiativeMcpSecretReferences(
  initiativeId: string,
  slots: readonly InitiativeMcpSecretSlot[],
): string[] {
  return slots.map(({ serverId, slot, destination }) =>
    initiativeMcpSecretReference(initiativeId, serverId, slot, destination));
}

/** Every vault reference the stored initiatives still use. */
export function liveInitiativeMcpSecretReferences(store: Pick<RuntimeStore, "initiatives">): Set<string> {
  return new Set(store.initiatives.list().flatMap((initiative) =>
    initiativeMcpSecretReferences(initiative.id, initiativeMcpSecretSlots(initiative.preferences.mcpServers))));
}

async function forgetOnce(
  broker: Pick<InitiativeMcpSecretBroker, "forget">,
  reference: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await broker.forget(reference);
      return true;
    } catch {
      // Tried once more below; a second failure is reported to the caller.
    }
  }
  return false;
}

/**
 * Removes vault entries through the broker, trying each one twice. With
 * `required`, a failure is thrown so the caller can refuse the change.
 * Otherwise no stored server refers to the entries any more: a failure is
 * logged and the references are kept in the pending list, which the next
 * start retries. A slot that is added again is cleared (with `required`)
 * before any run can resolve it, and leaves the pending list.
 */
export async function forgetInitiativeMcpSecrets(
  broker: Pick<InitiativeMcpSecretBroker, "forget"> | undefined,
  references: readonly string[],
  options: { required: boolean; pending?: InitiativeMcpPendingForgets },
): Promise<void> {
  if (!broker || references.length === 0) return;
  const failed: string[] = [];
  for (const reference of references) {
    if (!(await forgetOnce(broker, reference))) {
      if (options.required) throw new Error("Secure credential storage could not remove a secret.");
      failed.push(reference);
    }
  }
  if (options.required) {
    options.pending?.remove(references);
    return;
  }
  if (failed.length > 0) {
    console.warn(`${failed.length} initiative MCP secret(s) could not be removed from secure storage. Inertia will try again when it starts.`);
    options.pending?.add(failed);
  }
}

/**
 * Retries the pending list when the runtime starts: references a stored
 * initiative uses again are dropped from it, the rest are forgotten, and any
 * that still fail stay for the next start. Commands run meanwhile, so each
 * reference is checked again just before it is forgotten: one a saved change
 * uses again, or already took off the list, is left alone.
 */
export async function retryPendingInitiativeMcpForgets(
  broker: Pick<InitiativeMcpSecretBroker, "forget"> | undefined,
  store: Pick<RuntimeStore, "initiatives">,
  pending: InitiativeMcpPendingForgets,
): Promise<void> {
  if (!broker) return;
  const references = pending.list();
  if (references.length === 0) return;
  const done: string[] = [];
  for (const reference of references) {
    if (!pending.list().includes(reference)) continue;
    if (liveInitiativeMcpSecretReferences(store).has(reference) || await forgetOnce(broker, reference)) {
      done.push(reference);
    }
  }
  pending.remove(done);
  const waiting = pending.list().filter((reference) => references.includes(reference)).length;
  if (waiting > 0) {
    console.warn(`${waiting} initiative MCP secret(s) are still waiting to be removed from secure storage.`);
  }
}
