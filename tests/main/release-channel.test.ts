import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canaryUserDataPath,
  channelConfiguration,
  initializeInertiaReleaseChannel,
  installedApplicationName,
  releaseArtifactName,
  resolveInertiaReleaseChannel,
} from "../../src/main/release-channel";

const roots: string[] = [];

function packaged(channel: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "inertia-channel-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({
    inertiaReleaseChannel: channel,
  }));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("stable and Canary coexistence", () => {
  it("uses disjoint privileged identities, protocols, profiles, sessions, feeds, and caches", () => {
    const stable = channelConfiguration("stable");
    const canary = channelConfiguration("canary");
    for (const key of [
      "appId",
      "desktopName",
      "productName",
      "protocolScheme",
      "profileDirectoryName",
      "workspaceDirectoryName",
      "temporaryAttachmentDirectoryName",
      "updaterCacheDirectoryName",
      "updateFeedUrl",
    ] as const) {
      expect(canary[key]).not.toBe(stable[key]);
    }
    expect(stable.sessionPartition).toBeNull();
    expect(canary.sessionPartition).toBe("persist:inertia-canary");
  });

  it.each([
    ["darwin", "/Users/test/Library/Application Support"],
    ["win32", "C:\\Users\\test\\AppData\\Roaming"],
    ["linux", "/home/test/.config"],
  ])("keeps the %s Canary data directory separate from stable", (_platform, appData) => {
    expect(canaryUserDataPath(appData)).toBe(join(appData, "Inertia Canary"));
    expect(canaryUserDataPath(appData)).not.toBe(join(appData, "Inertia"));
  });

  it("trusts only a packaged marker and ignores production environment channel overrides", () => {
    expect(resolveInertiaReleaseChannel({
      isPackaged: true,
      appPath: packaged("canary"),
      nodeEnvironment: "production",
      testChannel: "stable",
    }).channel).toBe("canary");
    expect(resolveInertiaReleaseChannel({
      isPackaged: false,
      appPath: ".",
      nodeEnvironment: "production",
      testChannel: "canary",
    }).channel).toBe("stable");
    expect(() => resolveInertiaReleaseChannel({
      isPackaged: true,
      appPath: packaged("preview"),
    })).toThrow("marker is invalid");
  });

  it("configures the production Canary profile while preserving explicit test isolation", () => {
    const configuredPaths: Array<[string, string]> = [];
    const names: string[] = [];
    const appIds: string[] = [];
    const app = {
      isPackaged: true,
      getAppPath: () => packaged("canary"),
      getPath: (name: string) => name === "appData" ? "/profiles" : "/tmp/e2e-profile",
      setPath: (name: string, value: string) => { configuredPaths.push([name, value]); },
      setName: (name: string) => { names.push(name); },
      setAppUserModelId: (appId: string) => { appIds.push(appId); },
    } as Parameters<typeof initializeInertiaReleaseChannel>[0];
    expect(initializeInertiaReleaseChannel(app, { NODE_ENV: "production" }).configuration.channel)
      .toBe("canary");
    expect(configuredPaths).toEqual([["userData", join("/profiles", "Inertia Canary")]]);
    expect(names).toEqual(["Inertia Canary"]);
    expect(appIds).toEqual(["dev.inertia.app.canary"]);

    configuredPaths.length = 0;
    Object.assign(app, { isPackaged: false });
    initializeInertiaReleaseChannel(app, {
      NODE_ENV: "test",
      INERTIA_TEST_RELEASE_CHANNEL: "canary",
    });
    expect(configuredPaths).toEqual([["userData", "/tmp/e2e-profile"]]);
  });

  it("uses channel-specific package names on every release platform", () => {
    expect([
      releaseArtifactName("stable", "darwin", "1.2.3", "x64"),
      releaseArtifactName("stable", "darwin", "1.2.3", "arm64"),
      releaseArtifactName("stable", "win32", "1.2.3", "x64"),
      releaseArtifactName("stable", "win32", "1.2.3", "arm64"),
      releaseArtifactName("stable", "linux", "1.2.3", "x64"),
      releaseArtifactName("stable", "linux", "1.2.3", "arm64"),
    ]).toEqual([
      "Inertia-1.2.3.dmg",
      "Inertia-1.2.3-arm64.dmg",
      "Inertia.Setup.1.2.3.exe",
      "Inertia.Setup.1.2.3.arm64.exe",
      "Inertia-1.2.3.AppImage",
      "Inertia-1.2.3-arm64.AppImage",
    ]);
    expect([
      releaseArtifactName("canary", "darwin", "1.2.3", "x64"),
      releaseArtifactName("canary", "darwin", "1.2.3", "arm64"),
      releaseArtifactName("canary", "win32", "1.2.3", "x64"),
      releaseArtifactName("canary", "win32", "1.2.3", "arm64"),
      releaseArtifactName("canary", "linux", "1.2.3", "x64"),
      releaseArtifactName("canary", "linux", "1.2.3", "arm64"),
    ]).toEqual([
      "Inertia-Canary-1.2.3-x64.dmg",
      "Inertia-Canary-1.2.3-arm64.dmg",
      "Inertia.Canary.Setup.1.2.3.exe",
      "Inertia.Canary.Setup.1.2.3.arm64.exe",
      "Inertia-Canary-1.2.3.AppImage",
      "Inertia-Canary-1.2.3-arm64.AppImage",
    ]);
  });

  it("separates public artifact names from stable installed identities on all platforms", () => {
    expect([
      installedApplicationName("stable", "darwin"),
      installedApplicationName("stable", "win32"),
      installedApplicationName("stable", "linux"),
    ]).toEqual(["Inertia", "Inertia", "Inertia.AppImage"]);
    expect([
      installedApplicationName("canary", "darwin"),
      installedApplicationName("canary", "win32"),
      installedApplicationName("canary", "linux"),
    ]).toEqual(["Inertia Canary", "Inertia Canary", "Inertia Canary.AppImage"]);
    expect(releaseArtifactName("stable", "linux", "1.2.3", "x64"))
      .toBe("Inertia-1.2.3.AppImage");
  });
});
