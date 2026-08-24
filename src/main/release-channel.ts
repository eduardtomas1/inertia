import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { App } from "electron";

export type InertiaReleaseChannel = "stable" | "canary";

export interface InertiaReleaseChannelConfiguration {
  channel: InertiaReleaseChannel;
  appId: string;
  desktopName: string;
  productName: string;
  protocolScheme: "inertia" | "inertia-canary";
  sessionPartition: string | null;
  profileDirectoryName: string;
  workspaceDirectoryName: string;
  temporaryAttachmentDirectoryName: string;
  updaterCacheDirectoryName: string;
  updateFeedUrl: string;
  releaseTagPrefix: "v" | "canary-v";
}

const MAX_PACKAGED_MANIFEST_BYTES = 256 * 1_024;

const CHANNELS: Readonly<Record<
  InertiaReleaseChannel,
  InertiaReleaseChannelConfiguration
>> = Object.freeze({
  stable: Object.freeze({
    channel: "stable",
    appId: "dev.inertia.app",
    desktopName: "dev.inertia.app.desktop",
    productName: "Inertia",
    protocolScheme: "inertia",
    sessionPartition: null,
    profileDirectoryName: "Inertia",
    workspaceDirectoryName: "Inertia",
    temporaryAttachmentDirectoryName: "inertia-attachments",
    updaterCacheDirectoryName: "inertia-updater",
    updateFeedUrl:
      "https://github.com/eduardtomas1/inertia/releases/latest/download",
    releaseTagPrefix: "v",
  }),
  canary: Object.freeze({
    channel: "canary",
    appId: "dev.inertia.app.canary",
    desktopName: "dev.inertia.app.desktop.canary",
    productName: "Inertia Canary",
    protocolScheme: "inertia-canary",
    sessionPartition: "persist:inertia-canary",
    profileDirectoryName: "Inertia Canary",
    workspaceDirectoryName: "Inertia Canary",
    temporaryAttachmentDirectoryName: "inertia-canary-attachments",
    updaterCacheDirectoryName: "inertia-canary-updater",
    updateFeedUrl:
      "https://raw.githubusercontent.com/eduardtomas1/inertia/canary-feed",
    releaseTagPrefix: "canary-v",
  }),
});

function packagedChannel(appPath: string): InertiaReleaseChannel {
  const path = join(appPath, "package.json");
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    throw new Error("The packaged release-channel marker is missing.");
  }
  if (Buffer.byteLength(source, "utf8") > MAX_PACKAGED_MANIFEST_BYTES) {
    throw new Error("The packaged release-channel marker is oversized.");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(source);
  } catch {
    throw new Error("The packaged release-channel marker is invalid.");
  }
  const channel = typeof manifest === "object" && manifest !== null
    ? (manifest as { inertiaReleaseChannel?: unknown }).inertiaReleaseChannel
    : undefined;
  if (channel !== "stable" && channel !== "canary") {
    throw new Error("The packaged release-channel marker is invalid.");
  }
  return channel;
}

/** Resolves only build-authored channel state; production ignores environment overrides. */
export function resolveInertiaReleaseChannel(options: {
  isPackaged: boolean;
  appPath: string;
  nodeEnvironment?: string;
  testChannel?: string;
}): InertiaReleaseChannelConfiguration {
  const channel = options.isPackaged
    ? packagedChannel(options.appPath)
    : options.nodeEnvironment === "test" && options.testChannel === "canary"
      ? "canary"
      : "stable";
  return CHANNELS[channel];
}

export function canaryUserDataPath(appDataPath: string): string {
  return join(appDataPath, CHANNELS.canary.profileDirectoryName);
}

export function initializeInertiaReleaseChannel(
  app: Pick<App, "getAppPath" | "getPath" | "isPackaged" | "setAppUserModelId" | "setName" | "setPath">,
  environment: NodeJS.ProcessEnv,
): {
  configuration: InertiaReleaseChannelConfiguration;
  packageSmokeRoot: string | null;
} {
  const configuration = resolveInertiaReleaseChannel({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    nodeEnvironment: environment.NODE_ENV,
    testChannel: environment.INERTIA_TEST_RELEASE_CHANNEL,
  });
  const marker = environment.INERTIA_PACKAGE_SMOKE_FILE;
  const packageSmokeRoot = environment.NODE_ENV === "test"
    && typeof marker === "string"
    && isAbsolute(marker)
    && marker.length <= 4_096
    && !marker.includes("\0")
    ? dirname(marker)
    : null;
  if (configuration.channel === "canary") {
    app.setName(configuration.productName);
    app.setPath("userData", packageSmokeRoot
      ? join(packageSmokeRoot, "profile")
      : environment.NODE_ENV === "test"
        ? app.getPath("userData")
      : canaryUserDataPath(app.getPath("appData")));
  }
  app.setAppUserModelId(configuration.appId);
  return { configuration, packageSmokeRoot };
}

export function releaseRuntimeOverride(options: {
  configuration: InertiaReleaseChannelConfiguration;
  isPackaged: boolean;
  packageSmokeRoot: string | null;
  configuredPath: string | undefined;
  smokeDirectoryName: "data" | "workspace";
}): string | undefined {
  return options.configuration.channel === "canary" && options.isPackaged
    ? options.packageSmokeRoot
      ? join(options.packageSmokeRoot, options.smokeDirectoryName)
      : undefined
    : options.configuredPath;
}

export function releaseArtifactName(
  channel: InertiaReleaseChannel,
  platform: "darwin" | "win32" | "linux",
  version: string,
  architecture: "arm64" | "x64",
): string {
  if (channel === "stable") {
    if (platform === "darwin") {
      return architecture === "arm64"
        ? `Inertia-${version}-arm64.dmg`
        : `Inertia-${version}.dmg`;
    }
    if (platform === "win32") {
      return architecture === "arm64"
        ? `Inertia.Setup.${version}.arm64.exe`
        : `Inertia.Setup.${version}.exe`;
    }
    return architecture === "arm64"
      ? `Inertia-${version}-arm64.AppImage`
      : `Inertia-${version}.AppImage`;
  }
  if (platform === "darwin") return `Inertia-Canary-${version}-${architecture}.dmg`;
  if (platform === "win32") {
    return architecture === "arm64"
      ? `Inertia.Canary.Setup.${version}.arm64.exe`
      : `Inertia.Canary.Setup.${version}.exe`;
  }
  return architecture === "arm64"
    ? `Inertia-Canary-${version}-arm64.AppImage`
    : `Inertia-Canary-${version}.AppImage`;
}

export function releasePageUrl(
  channel: InertiaReleaseChannel,
  version: string,
): string {
  return `https://github.com/eduardtomas1/inertia/releases/tag/${CHANNELS[channel].releaseTagPrefix}${version}`;
}

export function channelConfiguration(
  channel: InertiaReleaseChannel,
): InertiaReleaseChannelConfiguration {
  return CHANNELS[channel];
}
