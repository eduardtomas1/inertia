import type { IpcMain, IpcMainInvokeEvent } from "electron";

import {
  AGENT_SECRET_SAVE_ERRORS,
  agentSecretValueIssue,
  parseSaveAgentSecretRequest,
  type SaveAgentSecretRequest,
  type SaveAgentSecretResult,
} from "../shared/agent-secrets.js";
import { DESKTOP_IPC } from "../shared/desktop-ipc.js";
import type { AgentSecretVaultWrite } from "./credential-vault.js";
import type {
  RuntimeAgentSecretDelivery,
  RuntimeAgentSecretDeliveryOutcome,
} from "./runtime-agent-secret-coordinator.js";

type RejectionReason = Extract<RuntimeAgentSecretDeliveryOutcome, { status: "rejected" }>["reason"];

const REJECTION_MESSAGES: Readonly<Record<RejectionReason, string>> = Object.freeze({
  "not-pending": AGENT_SECRET_SAVE_ERRORS.notPending,
  ended: AGENT_SECRET_SAVE_ERRORS.notPending,
  "file-failed": AGENT_SECRET_SAVE_ERRORS.fileFailed,
  limit: AGENT_SECRET_SAVE_ERRORS.limit,
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

async function vaultWrite(vault: AgentSecretVault, request: SaveAgentSecretRequest): Promise<AgentSecretVaultWrite> {
  try {
    return await vault.setAgentSecret(request.requestId, request.secret);
  } catch {
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

export function createAgentSecretSaver(
  options: AgentSecretSaverOptions,
): (sender: AgentSecretSender, value: unknown) => Promise<SaveAgentSecretResult> {
  const inFlight = new Set<string>();
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
      const vaulted = await vaultWrite(vault, request) === "stored";
      const outcome = await deliver(runtime, {
        conversationId: request.conversationId,
        requestId: request.requestId,
        secret: request.secret,
        vaulted,
      });
      if (outcome.status === "delivered") {
        return { status: "saved", expiresAt: outcome.expiresAt, storage: outcome.storage };
      }
      if (vaulted) await vault.deleteAgentSecret(request.requestId).catch(() => false);
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
