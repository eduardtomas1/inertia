import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { createIncidentReporter, type IncidentSink } from "../node/application-incidents.js";

import {
  parseBackendCredentialProfileRequest,
  parseSetBackendCredentialRequest,
  DISCORD_RELEASE_WEBHOOK_PROFILE_ID,
} from "../shared/backend-credentials.js";

type ProfileCredentialVault = {
  setForProfile: (profileId: string, secret: string) => Promise<unknown>;
  clearForProfile: (profileId: string) => Promise<unknown>;
  stateForProfile: (profileId: string) => Promise<unknown>;
};

const SET_CHANNEL = "inertia:set-backend-credential";
const CLEAR_CHANNEL = "inertia:clear-backend-credential";
const STATE_CHANNEL = "inertia:get-backend-credential-state";

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
  const perform = async (profileId: string, action: (vault: ProfileCredentialVault) => Promise<unknown>): Promise<unknown> => {
    try {
      const vault = credentialVault();
      if (!vault) throw new Error("Credential storage unavailable");
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
      if (profileId !== DISCORD_RELEASE_WEBHOOK_PROFILE_ID) throw error;
      const id = unavailable();
      throw new Error(`Secure webhook storage is unavailable.${id ? ` [incident:${id}]` : ""}`);
    }
  };
  ipcMain.handle(SET_CHANNEL, async (event, ...args) => {
    assertTrusted(event, args.length, 1);
    const request = parseSetBackendCredentialRequest(args[0]);
    if (!request) throw new Error("The backend credential request is invalid.");
    return await perform(request.profileId, (vault) => vault.setForProfile(request.profileId, request.secret));
  });
  ipcMain.handle(CLEAR_CHANNEL, async (event, ...args) => {
    assertTrusted(event, args.length, 1);
    const request = parseBackendCredentialProfileRequest(args[0]);
    if (!request) throw new Error("The backend credential request is invalid.");
    return await perform(request.profileId, (vault) => vault.clearForProfile(request.profileId));
  });
  ipcMain.handle(STATE_CHANNEL, async (event, ...args) => {
    assertTrusted(event, args.length, 1);
    const request = parseBackendCredentialProfileRequest(args[0]);
    if (!request) throw new Error("The backend credential request is invalid.");
    return await perform(request.profileId, (vault) => vault.stateForProfile(request.profileId));
  });
}
