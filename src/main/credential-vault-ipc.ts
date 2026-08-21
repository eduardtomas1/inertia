import type { IpcMain, IpcMainInvokeEvent } from "electron";

import {
  parseBackendCredentialProfileRequest,
  parseSetBackendCredentialRequest,
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
): void {
  ipcMain.handle(SET_CHANNEL, async (event, ...args) => {
    assertTrusted(event, args.length, 1);
    const request = parseSetBackendCredentialRequest(args[0]);
    const vault = credentialVault();
    if (!request || !vault) throw new Error("The backend credential request is invalid.");
    return await vault.setForProfile(request.profileId, request.secret);
  });
  ipcMain.handle(CLEAR_CHANNEL, async (event, ...args) => {
    assertTrusted(event, args.length, 1);
    const request = parseBackendCredentialProfileRequest(args[0]);
    const vault = credentialVault();
    if (!request || !vault) throw new Error("The backend credential request is invalid.");
    return await vault.clearForProfile(request.profileId);
  });
  ipcMain.handle(STATE_CHANNEL, async (event, ...args) => {
    assertTrusted(event, args.length, 1);
    const request = parseBackendCredentialProfileRequest(args[0]);
    const vault = credentialVault();
    if (!request || !vault) throw new Error("The backend credential request is invalid.");
    return await vault.stateForProfile(request.profileId);
  });
}
