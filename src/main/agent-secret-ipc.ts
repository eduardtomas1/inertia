import { createHmac, randomBytes } from "node:crypto";

import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { agentSecretValueIssue, parseSaveAgentSecretRequest } from "../node/agent-secrets.js";
import { AGENT_SECRET_SAVE_ERRORS } from "../shared/agent-secret-save-errors.js";
import type { SaveAgentSecretRequest, SaveAgentSecretResult } from "../shared/agent-secrets.js";
import { DESKTOP_IPC } from "../shared/desktop-ipc.js";
import { CredentialVaultError, type AgentSecretVaultWrite } from "./credential-vault.js";
import type {
  RuntimeAgentSecretDelivery,
  RuntimeAgentSecretDeliveryOutcome,
} from "./runtime-agent-secret-coordinator.js";

type RejectionReason = Extract<RuntimeAgentSecretDeliveryOutcome, { status: "rejected" }>["reason"];

const MAX_UNCERTAIN_VAULT_ENTRIES = 128;

const REJECTION_MESSAGES: Readonly<Record<RejectionReason, string>> = Object.freeze({
  "not-pending": AGENT_SECRET_SAVE_ERRORS.notPending,
  ended: AGENT_SECRET_SAVE_ERRORS.notPending,
  "file-failed": AGENT_SECRET_SAVE_ERRORS.fileFailed,
  limit: AGENT_SECRET_SAVE_ERRORS.limit,
  invalid: AGENT_SECRET_SAVE_ERRORS.invalid,
  unavailable: AGENT_SECRET_SAVE_ERRORS.runtimeUnavailable,
});

export type AgentSecretSender =
  | { role: "main" }
  | { role: "detached-chat"; conversationId: string };

export interface AgentSecretVault {
  setAgentSecret(requestId: string, secret: string): Promise<AgentSecretVaultWrite>;
  deleteAgentSecret(requestId: string): Promise<boolean>;
}

export interface AgentSecretRuntime {
  deliverAgentSecret(delivery: RuntimeAgentSecretDelivery): Promise<RuntimeAgentSecretDeliveryOutcome>;
}

export interface AgentSecretSaverOptions {
  vault: () => AgentSecretVault | null;
  runtime: () => AgentSecretRuntime | null;
  onVaultWriteError?: (code: string) => void;
}

export interface AgentSecretIpcOptions extends AgentSecretSaverOptions {
  ipcMain: Pick<IpcMain, "handle">;
  assertTrusted: (event: IpcMainInvokeEvent, receivedArgumentCount: number, expectedArgumentCount: number) => AgentSecretSender;
}

function requestIssue(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.hasOwn(value, "secret")) {
    return AGENT_SECRET_SAVE_ERRORS.invalid;
  }
  return agentSecretValueIssue((value as Record<string, unknown>).secret) ?? AGENT_SECRET_SAVE_ERRORS.invalid;
}

async function vaultWrite(
  vault: AgentSecretVault,
  request: SaveAgentSecretRequest,
  onVaultWriteError?: (code: string) => void,
): Promise<AgentSecretVaultWrite> {
  try {
    return await vault.setAgentSecret(request.requestId, request.secret);
  } catch (error) {
    const code = error instanceof CredentialVaultError ? error.code : "unknown";
    try {
      onVaultWriteError?.(code);
    } catch {
    }
    return "unavailable";
  }
}

async function deliver(runtime: AgentSecretRuntime, delivery: RuntimeAgentSecretDelivery): Promise<RuntimeAgentSecretDeliveryOutcome> {
  try {
    return await runtime.deliverAgentSecret(delivery);
  } catch {
    return { status: "rejected", reason: "unavailable" };
  }
}

function recordUncertainEntry(entries: Map<string, string>, requestId: string, fingerprint: string): void {
  entries.delete(requestId);
  entries.set(requestId, fingerprint);
  while (entries.size > MAX_UNCERTAIN_VAULT_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

export function createAgentSecretSaver(
  options: AgentSecretSaverOptions,
): (sender: AgentSecretSender, value: unknown) => Promise<SaveAgentSecretResult> {
  const inFlight = new Set<string>();
  const uncertainVaultEntries = new Map<string, string>();
  const fingerprintKey = randomBytes(32);
  const fingerprint = (secret: string): string => createHmac("sha256", fingerprintKey).update(secret, "utf8").digest("hex");
  return async (sender, value) => {
    const request = parseSaveAgentSecretRequest(value);
    if (!request) throw new Error(requestIssue(value));
    if (sender.role !== "main" && sender.conversationId !== request.conversationId) {
      throw new Error(AGENT_SECRET_SAVE_ERRORS.foreignConversation);
    }
    const vault = options.vault();
    if (!vault) throw new Error(AGENT_SECRET_SAVE_ERRORS.storageStarting);
    const runtime = options.runtime();
    if (!runtime) throw new Error(AGENT_SECRET_SAVE_ERRORS.runtimeUnavailable);
    if (inFlight.has(request.requestId)) throw new Error(AGENT_SECRET_SAVE_ERRORS.notPending);
    inFlight.add(request.requestId);
    try {
      const uncertainFingerprint = uncertainVaultEntries.get(request.requestId);
      const requestFingerprint = fingerprint(request.secret);
      const wroteVaultNow = uncertainFingerprint === undefined
        && await vaultWrite(vault, request, options.onVaultWriteError) === "stored";
      const vaulted = wroteVaultNow || uncertainFingerprint === requestFingerprint;
      const outcome = await deliver(runtime, {
        conversationId: request.conversationId,
        requestId: request.requestId,
        secret: request.secret,
        vaulted,
      });
      if (outcome.status === "delivered") {
        uncertainVaultEntries.delete(request.requestId);
        if (uncertainFingerprint !== undefined && outcome.storage === "memory") {
          await vault.deleteAgentSecret(request.requestId).catch(() => false);
        }
        return { status: "saved", expiresAt: outcome.expiresAt, storage: outcome.storage };
      }
      if (wroteVaultNow) {
        if (outcome.reason !== "unavailable" || outcome.dispatched === false) {
          await vault.deleteAgentSecret(request.requestId).catch(() => false);
        } else {
          recordUncertainEntry(uncertainVaultEntries, request.requestId, requestFingerprint);
        }
      } else if (
        uncertainFingerprint !== undefined
        && (outcome.reason === "file-failed" || outcome.reason === "limit" || outcome.reason === "invalid")
      ) {
        // These rejections prove the request was still pending (earlier timed-out save did not commit).
        uncertainVaultEntries.delete(request.requestId);
        await vault.deleteAgentSecret(request.requestId).catch(() => false);
      }
      throw new Error(REJECTION_MESSAGES[outcome.reason]);
    } finally {
      inFlight.delete(request.requestId);
    }
  };
}

export function registerAgentSecretIpc(options: AgentSecretIpcOptions): void {
  const save = createAgentSecretSaver(options);
  options.ipcMain.handle(DESKTOP_IPC.saveAgentSecret, async (event, ...args) => {
    const sender = options.assertTrusted(event, args.length, 1);
    return await save(sender, args[0]);
  });
}
