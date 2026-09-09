import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { createIncidentReporter, type IncidentSink } from "../node/application-incidents.js";
import type { SendDiscordReleaseInfoResult } from "../shared/desktop.js";

import {
  DISCORD_RELEASE_WEBHOOK_PROFILE_ID,
} from "../shared/backend-credentials.js";
import { backendSecretReferenceForProfile } from "./credential-vault.js";
import {
  listInertiaReleases,
  sendDiscordReleaseInfo,
  ReleaseOperationError,
  validateReleaseRepository,
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
  onIncident?: IncidentSink,
): void {
  const report = createIncidentReporter(onIncident);
  ipcMain.handle(SEND_RELEASE_CHANNEL, async (event, ...args): Promise<SendDiscordReleaseInfoResult> => {
    assertTrusted(event, args.length, 1);
    try {
      const request = args[0];
      validateReleaseRepository(request?.repositoryUrl);
      const [release, previousRelease] = await listInertiaReleases(fetch, request);
      if (!release || !previousRelease) {
        throw new ReleaseOperationError("discord.release-fetch-failed", "At least two published releases are required.");
      }
      let webhookUrl: string | null;
      try {
        const vault = credentialVault();
        if (!vault) throw new Error("Credential vault unavailable");
        webhookUrl = await vault.resolve(backendSecretReferenceForProfile(DISCORD_RELEASE_WEBHOOK_PROFILE_ID));
      } catch { throw new ReleaseOperationError("discord.credential-unavailable", "Secure credential storage is unavailable."); }
      if (!webhookUrl) throw new ReleaseOperationError("discord.webhook-missing", "A Discord webhook URL is required.");
      const result = await sendDiscordReleaseInfo(fetch, webhookUrl, {
        repositoryUrl: request.repositoryUrl, previousRelease, release,
      });
      const incidentId = result.comparisonLimited
        ? report({ code: "discord.comparison-limited", outcome: "recovered" }) : null;
      return { ...result, ...(incidentId ? { incidentId } : {}) };
    } catch (error) {
      const code = error instanceof ReleaseOperationError ? error.code : "discord.release-fetch-failed";
      const incidentId = report({ code,
        outcome: code === "discord.delivery-unknown" ? "unknown"
          : code === "discord.delivery-rejected" ? "failed" : "not-started",
        metadata: error instanceof ReleaseOperationError && error.httpStatus ? { httpStatus: error.httpStatus } : {},
      });
      return { sent: false, code, ...(incidentId ? { incidentId } : {}) };
    }
  });
}
