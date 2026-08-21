import type { IpcMain, IpcMainInvokeEvent } from "electron";

import {
  DISCORD_RELEASE_WEBHOOK_PROFILE_ID,
} from "../shared/backend-credentials.js";
import { backendSecretReferenceForProfile } from "./credential-vault.js";
import {
  listInertiaReleases,
  sendDiscordReleaseInfo,
} from "./inertia-releases.js";

type CredentialResolver = {
  resolve: (secretReference: string) => Promise<string | null>;
};

const SEND_RELEASE_CHANNEL = "inertia:send-discord-release-info";

export function registerInertiaReleaseIpc(
  ipcMain: IpcMain,
  fetch: typeof globalThis.fetch,
  credentialVault: () => CredentialResolver | null,
  assertTrusted: (
    event: IpcMainInvokeEvent,
    receivedArgumentCount: number,
    expectedArgumentCount?: number,
  ) => void,
): void {
  ipcMain.handle(SEND_RELEASE_CHANNEL, async (event, ...args) => {
    assertTrusted(event, args.length, 1);
    const request = args[0];
    const [release, previousRelease] = await listInertiaReleases(fetch, request);
    if (!release || !previousRelease) {
      throw new Error("At least two releases are required to build the comparison.");
    }
    const vault = credentialVault();
    if (!vault) throw new Error("Secure credential storage is unavailable.");
    const webhookUrl = await vault.resolve(
      backendSecretReferenceForProfile(DISCORD_RELEASE_WEBHOOK_PROFILE_ID),
    );
    if (!webhookUrl) throw new Error("A Discord webhook URL is required.");
    return await sendDiscordReleaseInfo(fetch, webhookUrl, {
      repositoryUrl: request?.repositoryUrl,
      previousRelease,
      release,
    });
  });
}
