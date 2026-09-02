import type { AppUpdateCapability } from "./app-update.js";
import { AppUpdateService } from "./app-update.js";
import { CanaryRollbackManager } from "./canary-rollback.js";
import { loadElectronAppUpdater } from "./electron-app-updater.js";
import type { InertiaReleaseChannelConfiguration } from "./release-channel.js";

interface ReleaseUpdatesOptions {
  configuration: InertiaReleaseChannelConfiguration;
  currentVersion: string;
  capability: AppUpdateCapability;
  fetch: typeof globalThis.fetch;
  testUpdateVersion?: string;
  userDataDirectory: string;
  platform: NodeJS.Platform;
  architecture: string;
  openPath(path: string): Promise<string>;
  revealPath(path: string): void;
  activeAppImagePath?: string;
}

export function initializeReleaseUpdates(options: ReleaseUpdatesOptions): {
  service: AppUpdateService;
  rollbackManager: CanaryRollbackManager | null;
} {
  const channel = options.configuration.channel;
  const fetch = options.testUpdateVersion === undefined
    ? options.fetch
    : async () => new Response(JSON.stringify(channel === "canary"
        ? { version: options.testUpdateVersion!.replace(/^v/u, "") }
        : { tag_name: `v${options.testUpdateVersion!.replace(/^v/u, "")}` }));
  return {
    service: new AppUpdateService({
      currentVersion: options.currentVersion,
      channel,
      capability: options.capability,
      loadUpdater: () => loadElectronAppUpdater(channel, {
        platform: options.platform,
        ...(options.activeAppImagePath === undefined
          ? {} : { activeAppImagePath: options.activeAppImagePath }),
      }),
      fetch,
    }),
    rollbackManager: channel === "canary"
      ? new CanaryRollbackManager({
          channel,
          version: options.currentVersion,
          platform: options.platform,
          architecture: options.architecture,
          userDataDirectory: options.userDataDirectory,
          fetch: options.fetch,
          openPath: options.openPath,
          revealPath: options.revealPath,
          ...(options.activeAppImagePath === undefined
            ? {} : { activeAppImagePath: options.activeAppImagePath }),
        })
      : null,
  };
}
