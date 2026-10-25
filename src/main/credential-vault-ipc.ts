import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { createIncidentReporter, type IncidentSink } from "../node/application-incidents.js";

import {
  backendCredentialSecretIssue,
  parseBackendCredentialProfileRequest,
  parseSetBackendCredentialRequest,
  DISCORD_RELEASE_WEBHOOK_PROFILE_ID,
} from "../shared/backend-credentials.js";
import { DESKTOP_IPC } from "../shared/desktop-ipc.js";
import { CredentialVaultError } from "./credential-vault.js";

type ProfileCredentialVault = {
  setForProfile: (profileId: string, secret: string) => Promise<unknown>;
  clearForProfile: (profileId: string) => Promise<unknown>;
  stateForProfile: (profileId: string) => Promise<unknown>;
};

type CredentialOperation = "save" | "remove" | "read";

class CredentialVaultStartingError extends Error {}

const OPERATION_OUTCOMES: Readonly<Record<CredentialOperation, string>> = {
  save: "The key was not saved",
  remove: "The key was not removed",
  read: "The saved key could not be checked",
};

const VAULT_FAILURE_CAUSES: Readonly<Record<CredentialVaultError["code"], string>> = {
  "invalid-input": "the request was not valid",
  "storage-unavailable": "secure storage is not available on this computer",
  "storage-corrupt": "the secure credential file is damaged",
  "encryption-failed": "secure storage could not encrypt it",
  "decryption-failed": "secure storage could not unlock it",
  "persistence-failed": "the secure credential file could not be written",
};

function vaultFailureMessage(operation: CredentialOperation, error: unknown): string {
  if (error instanceof CredentialVaultError && error.publicDetail) {
    return `${OPERATION_OUTCOMES[operation]}. ${error.publicDetail}`;
  }
  const cause = error instanceof CredentialVaultStartingError
    ? "secure storage is still starting. Try again in a moment"
    : error instanceof CredentialVaultError
      ? VAULT_FAILURE_CAUSES[error.code]
      : "secure storage failed";
  return `${OPERATION_OUTCOMES[operation]} because ${cause}.`;
}

function setCredentialIssue(value: unknown): string {
  const secret = typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>).secret
    : undefined;
  return backendCredentialSecretIssue(secret) ?? "The backend credential request is invalid.";
}

export function registerCredentialVaultIpc(
  ipcMain: IpcMain,
  credentialVault: () => ProfileCredentialVault | null,
  assertTrusted: (
    event: IpcMainInvokeEvent,
    receivedArgumentCount: number,
    expectedArgumentCount?: number,
  ) => void,
  onIncident?: IncidentSink,
): void {
  const report = createIncidentReporter(onIncident);
  let storageIncident: string | null = null;
  const unavailable = (): string | null => storageIncident ??= report({ code: "discord.credential-unavailable", outcome: "unknown" });
  const perform = async (
    profileId: string,
    operation: CredentialOperation,
    action: (vault: ProfileCredentialVault) => Promise<unknown>,
  ): Promise<unknown> => {
    try {
      const vault = credentialVault();
      if (!vault) throw new CredentialVaultStartingError();
      const result = await action(vault);
      if (profileId === DISCORD_RELEASE_WEBHOOK_PROFILE_ID && result && typeof result === "object"
        && "storage" in result && result.storage && typeof result.storage === "object" && "available" in result.storage) {
        if (result.storage.available === false) {
          const diagnosticId = unavailable();
          return { ...result, ...(diagnosticId ? { diagnosticId } : {}) };
        }
        if (result.storage.available === true && storageIncident) {
          report({ id: storageIncident, code: "discord.credential-unavailable", outcome: "recovered" });
          storageIncident = null;
        }
      }
      return result;
    } catch (error) {
      if (profileId !== DISCORD_RELEASE_WEBHOOK_PROFILE_ID) {
        throw new Error(vaultFailureMessage(operation, error));
      }
      const id = unavailable();
      throw new Error(`Secure webhook storage is unavailable.${id ? ` [incident:${id}]` : ""}`);
    }
  };
  ipcMain.handle(DESKTOP_IPC.setBackendCredential, async (event, ...args) => {
    assertTrusted(event, args.length, 1);
    const request = parseSetBackendCredentialRequest(args[0]);
    if (!request) throw new Error(setCredentialIssue(args[0]));
    return await perform(request.profileId, "save", (vault) => vault.setForProfile(request.profileId, request.secret));
  });
  ipcMain.handle(DESKTOP_IPC.clearBackendCredential, async (event, ...args) => {
    assertTrusted(event, args.length, 1);
    const request = parseBackendCredentialProfileRequest(args[0]);
    if (!request) throw new Error("The backend credential request is invalid.");
    return await perform(request.profileId, "remove", (vault) => vault.clearForProfile(request.profileId));
  });
  ipcMain.handle(DESKTOP_IPC.getBackendCredentialState, async (event, ...args) => {
    assertTrusted(event, args.length, 1);
    const request = parseBackendCredentialProfileRequest(args[0]);
    if (!request) throw new Error("The backend credential request is invalid.");
    return await perform(request.profileId, "read", (vault) => vault.stateForProfile(request.profileId));
  });
}
