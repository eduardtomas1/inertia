import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { createPackage } from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  name: string;
  version: string;
};
const version = packageJson.version;
const releaseTag = `v${version}`;
const temporaryDirectories = new Set<string>();
const require = createRequire(import.meta.url);

interface ResolvedUpdaterFile {
  url: URL;
  info: { url: string };
}

const { findFile } = require("electron-updater/out/providers/Provider.js") as {
  findFile: (
    files: ResolvedUpdaterFile[],
    extension: string,
    excludedExtensions?: string[],
  ) => ResolvedUpdaterFile | undefined;
};
const { MacUpdater } = require("electron-updater/out/MacUpdater.js") as {
  MacUpdater: {
    filterFilesForArch: (
      files: ResolvedUpdaterFile[],
      isArm64Mac: boolean,
    ) => ResolvedUpdaterFile[];
  };
};

const policies = {
  "macos-x64": {
    packages: [`Inertia-${version}.dmg`, `Inertia-${version}-mac.zip`],
    metadata: "latest-mac.yml",
    companions: [`Inertia-${version}-mac.zip.blockmap`],
    packagedUpdateConfig: "mac/Inertia.app/Contents/Resources/app-update.yml",
    packagedAppArchive: "mac/Inertia.app/Contents/Resources/app.asar",
  },
  "macos-arm64": {
    packages: [`Inertia-${version}-arm64.dmg`, `Inertia-${version}-arm64-mac.zip`],
    metadata: "latest-mac.yml",
    companions: [`Inertia-${version}-arm64-mac.zip.blockmap`],
    packagedUpdateConfig: "mac-arm64/Inertia.app/Contents/Resources/app-update.yml",
    packagedAppArchive: "mac-arm64/Inertia.app/Contents/Resources/app.asar",
  },
  "windows-x64": {
    packages: [`Inertia.Setup.${version}.exe`],
    metadata: "latest.yml",
    companions: [`Inertia.Setup.${version}.exe.blockmap`],
    packagedUpdateConfig: "win-unpacked/resources/app-update.yml",
    packagedAppArchive: "win-unpacked/resources/app.asar",
  },
  "windows-arm64": {
    packages: [`Inertia.Setup.${version}.arm64.exe`],
    metadata: "latest.yml",
    companions: [`Inertia.Setup.${version}.arm64.exe.blockmap`],
    packagedUpdateConfig: "win-arm64-unpacked/resources/app-update.yml",
    packagedAppArchive: "win-arm64-unpacked/resources/app.asar",
  },
  "linux-x64": {
    packages: [`Inertia-${version}.AppImage`],
    metadata: "latest-linux.yml",
    companions: [],
    packagedUpdateConfig: "linux-unpacked/resources/app-update.yml",
    packagedAppArchive: "linux-unpacked/resources/app.asar",
  },
  "linux-arm64": {
    packages: [`Inertia-${version}-arm64.AppImage`],
    metadata: "latest-linux-arm64.yml",
    companions: [],
    packagedUpdateConfig: "linux-arm64-unpacked/resources/app-update.yml",
    packagedAppArchive: "linux-arm64-unpacked/resources/app.asar",
  },
} as const;
const canaryPolicies = {
  "macos-x64": {
    packages: [`Inertia-Canary-${version}-x64.dmg`, `Inertia-Canary-${version}-x64.zip`],
    metadata: "canary-mac.yml",
    companions: [`Inertia-Canary-${version}-x64.zip.blockmap`],
    packagedUpdateConfig: "mac/Inertia Canary.app/Contents/Resources/app-update.yml",
    packagedAppArchive: "mac/Inertia Canary.app/Contents/Resources/app.asar",
  },
  "macos-arm64": {
    packages: [`Inertia-Canary-${version}-arm64.dmg`, `Inertia-Canary-${version}-arm64.zip`],
    metadata: "canary-mac.yml",
    companions: [`Inertia-Canary-${version}-arm64.zip.blockmap`],
    packagedUpdateConfig: "mac-arm64/Inertia Canary.app/Contents/Resources/app-update.yml",
    packagedAppArchive: "mac-arm64/Inertia Canary.app/Contents/Resources/app.asar",
  },
  "windows-x64": {
    packages: [`Inertia.Canary.Setup.${version}.exe`],
    metadata: "canary.yml",
    companions: [`Inertia.Canary.Setup.${version}.exe.blockmap`],
    packagedUpdateConfig: "win-unpacked/resources/app-update.yml",
    packagedAppArchive: "win-unpacked/resources/app.asar",
  },
  "windows-arm64": {
    packages: [`Inertia.Canary.Setup.${version}.arm64.exe`],
    metadata: "canary.yml",
    companions: [`Inertia.Canary.Setup.${version}.arm64.exe.blockmap`],
    packagedUpdateConfig: "win-arm64-unpacked/resources/app-update.yml",
    packagedAppArchive: "win-arm64-unpacked/resources/app.asar",
  },
  "linux-x64": {
    packages: [`Inertia-Canary-${version}.AppImage`],
    metadata: "canary-linux.yml",
    companions: [],
    packagedUpdateConfig: "linux-unpacked/resources/app-update.yml",
    packagedAppArchive: "linux-unpacked/resources/app.asar",
  },
  "linux-arm64": {
    packages: [`Inertia-Canary-${version}-arm64.AppImage`],
    metadata: "canary-linux-arm64.yml",
    companions: [],
    packagedUpdateConfig: "linux-arm64-unpacked/resources/app-update.yml",
    packagedAppArchive: "linux-arm64-unpacked/resources/app.asar",
  },
} as const;

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "inertia-release-assets-"));
  temporaryDirectories.add(path);
  return path;
}

function sha512(value: Buffer): string {
  return createHash("sha512").update(value).digest("base64");
}

async function writeFixture(
  sourceRoot: string,
  platform: keyof typeof policies,
  options: {
    channel?: "stable" | "canary";
    feedUrl?: string;
    overrideUrl?: string;
    delivery?: "in-app" | "manual";
    includePublisherName?: boolean;
  } = {},
): Promise<void> {
  const channel = options.channel ?? "stable";
  const policy = channel === "canary" ? canaryPolicies[platform] : policies[platform];
  const delivery = options.delivery ?? "in-app";
  const platformMarker = platform.startsWith("macos-")
    ? "darwin"
    : platform.startsWith("windows-")
      ? "win32"
      : "linux";
  const manualReason = platform.startsWith("macos-")
    ? "macos-signing-unavailable"
    : "windows-signing-unavailable";
  const capability = delivery === "in-app"
    ? { delivery, platform: platformMarker }
    : { delivery, reason: manualReason };
  const manifestSource = join(sourceRoot, `.manifest-${platform}`);
  const archivePath = join(sourceRoot, policy.packagedAppArchive);
  await mkdir(manifestSource, { recursive: true });
  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(join(manifestSource, "package.json"), JSON.stringify({
    name: channel === "canary" ? "inertia-canary" : packageJson.name,
    version,
    inertiaReleaseChannel: channel,
    inertiaUpdateCapability: capability,
  }));
  await createPackage(manifestSource, archivePath);

  const updateConfigPath = join(sourceRoot, policy.packagedUpdateConfig);
  await mkdir(dirname(updateConfigPath), { recursive: true });
  const includePublisherName = options.includePublisherName
    ?? (platform.startsWith("windows-") && delivery === "in-app");
  await writeFile(
    updateConfigPath,
    [
      "provider: generic",
      `url: ${options.feedUrl ?? (channel === "canary"
        ? "https://raw.githubusercontent.com/eduardtomas1/inertia/canary-feed"
        : "https://github.com/eduardtomas1/inertia/releases/latest/download")}`,
      `updaterCacheDirName: ${channel === "canary" ? "inertia-canary-updater" : "inertia-updater"}`,
      ...(channel === "canary" ? ["channel: canary"] : []),
      ...(includePublisherName ? ["publisherName: Inertia Test Publisher"] : []),
      "",
    ].join("\n"),
  );

  const packageValues = new Map<string, Buffer>();
  const companionValues = new Map<string, Buffer>();
  for (const name of policy.packages) {
    const value = Buffer.from(`fixture:${platform}:${name}`, "utf8");
    packageValues.set(name, value);
    await writeFile(join(sourceRoot, name), value);
  }
  for (const name of policy.companions) {
    const value = Buffer.from(`blockmap:${platform}:${name}`, "utf8");
    companionValues.set(name, value);
    await writeFile(join(sourceRoot, name), value);
  }

  const files = policy.packages.flatMap((name) => {
    const value = packageValues.get(name);
    if (!value) throw new Error(`Missing fixture package ${name}.`);
    return [
      `  - url: ${options.overrideUrl ?? name}`,
      `    sha512: ${sha512(value)}`,
      `    size: ${value.length}`,
      ...(companionValues.has(`${name}.blockmap`)
        ? [`    blockMapSize: ${companionValues.get(`${name}.blockmap`)!.length}`]
        : []),
    ];
  });
  const primaryName = policy.packages.at(-1);
  if (!primaryName) throw new Error(`Missing primary fixture package for ${platform}.`);
  const primaryValue = packageValues.get(primaryName);
  if (!primaryValue) throw new Error(`Missing primary fixture value for ${platform}.`);
  await writeFile(
    join(sourceRoot, policy.metadata),
    [
      `version: ${version}`,
      "files:",
      ...files,
      `path: ${primaryName}`,
      `sha512: ${sha512(primaryValue)}`,
      "releaseDate: 2026-08-17T00:00:00.000Z",
      "",
    ].join("\n"),
  );
}

function runReleaseAssets(
  args: string[],
  environment: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["scripts/release-assets.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_TAG: releaseTag,
      ...environment,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map(async (path) => await rm(path, { recursive: true, force: true })));
  temporaryDirectories.clear();
});

describe("release asset staging", () => {
  it("validates and consolidates the disjoint Canary artifact and metadata union", async () => {
    const fixtureRoot = await temporaryDirectory();
    const sourceRoot = join(fixtureRoot, "source");
    const stageRoot = join(fixtureRoot, "stage");
    await mkdir(sourceRoot);
    for (const platform of Object.keys(canaryPolicies) as Array<keyof typeof canaryPolicies>) {
      await writeFixture(sourceRoot, platform, { channel: "canary" });
      const staged = runReleaseAssets(["stage", platform], {
        INERTIA_RELEASE_CHANNEL: "canary",
        RELEASE_TAG: `canary-v${version}`,
        INERTIA_RELEASE_SOURCE_DIR: sourceRoot,
        INERTIA_RELEASE_STAGE_DIR: stageRoot,
      });
      expect(staged.status, staged.stderr).toBe(0);
    }
    const finalized = runReleaseAssets(["finalize"], {
      INERTIA_RELEASE_CHANNEL: "canary",
      RELEASE_TAG: `canary-v${version}`,
      INERTIA_RELEASE_DOWNLOAD_DIR: stageRoot,
    });
    expect(finalized.status, finalized.stderr).toBe(0);
    const entries = (await readdir(join(stageRoot, "final"))).sort();
    expect(Object.keys(canaryPolicies)).toEqual([
      "macos-x64",
      "macos-arm64",
      "windows-x64",
      "windows-arm64",
      "linux-x64",
      "linux-arm64",
    ]);
    expect(entries).toEqual([...new Set([
      ...Object.values(canaryPolicies).flatMap((policy) => [
        ...policy.packages,
        policy.metadata,
        ...policy.companions,
      ]),
      "SHA256SUMS.txt",
    ])].sort());
    for (const [metadata, platforms] of [
      ["canary-mac.yml", ["macos-x64", "macos-arm64"]],
      ["canary.yml", ["windows-x64", "windows-arm64"]],
    ] as const) {
      const document = parse(
        await readFile(join(stageRoot, "final", metadata), "utf8"),
      ) as { files: Array<{ url: string }> };
      expect(document.files.map(({ url }) => url)).toEqual(
        platforms.flatMap((platform) => canaryPolicies[platform].packages),
      );
    }
  });

  it("retains every Canary package while omitting unsigned desktop feed metadata", async () => {
    const fixtureRoot = await temporaryDirectory();
    const sourceRoot = join(fixtureRoot, "source");
    const stageRoot = join(fixtureRoot, "stage");
    await mkdir(sourceRoot);
    for (const platform of Object.keys(canaryPolicies) as Array<keyof typeof canaryPolicies>) {
      await writeFixture(sourceRoot, platform, {
        channel: "canary",
        delivery: platform.startsWith("linux-") ? "in-app" : "manual",
      });
      const staged = runReleaseAssets(["stage", platform], {
        INERTIA_RELEASE_CHANNEL: "canary",
        RELEASE_TAG: `canary-v${version}`,
        INERTIA_RELEASE_SOURCE_DIR: sourceRoot,
        INERTIA_RELEASE_STAGE_DIR: stageRoot,
      });
      expect(staged.status, staged.stderr).toBe(0);
    }
    const finalized = runReleaseAssets(["finalize"], {
      INERTIA_RELEASE_CHANNEL: "canary",
      RELEASE_TAG: `canary-v${version}`,
      INERTIA_RELEASE_DOWNLOAD_DIR: stageRoot,
    });
    expect(finalized.status, finalized.stderr).toBe(0);
    const entries = await readdir(join(stageRoot, "final"));
    expect(entries).toEqual(expect.arrayContaining([
      ...Object.values(canaryPolicies).flatMap((policy) => policy.packages),
      "canary-linux.yml",
      "canary-linux-arm64.yml",
      "SHA256SUMS.txt",
    ]));
    expect(entries).not.toContain("canary-mac.yml");
    expect(entries).not.toContain("canary.yml");
  });

  it("validates and consolidates the exact updater asset union", async () => {
    const fixtureRoot = await temporaryDirectory();
    const sourceRoot = join(fixtureRoot, "source");
    const stageRoot = join(fixtureRoot, "stage");
    await mkdir(sourceRoot);
    for (const platform of Object.keys(policies) as Array<keyof typeof policies>) {
      await writeFixture(sourceRoot, platform);
      const staged = runReleaseAssets(["stage", platform], {
        INERTIA_RELEASE_SOURCE_DIR: sourceRoot,
        INERTIA_RELEASE_STAGE_DIR: stageRoot,
      });
      expect(staged.status, staged.stderr).toBe(0);
    }

    const finalized = runReleaseAssets(["finalize"], {
      INERTIA_RELEASE_DOWNLOAD_DIR: stageRoot,
    });
    expect(finalized.status, finalized.stderr).toBe(0);
    const entries = (await readdir(join(stageRoot, "final"))).sort();
    const expected = [...new Set([
      ...Object.values(policies).flatMap((policy) => [
        ...policy.packages,
        policy.metadata,
        ...policy.companions,
      ]),
      "SHA256SUMS.txt",
    ])].sort();
    expect(entries).toEqual(expected);
    const checksums = await readFile(join(stageRoot, "final", "SHA256SUMS.txt"), "utf8");
    expect(checksums.trim().split("\n")).toHaveLength(expected.length - 1);

    const macMetadata = parse(
      await readFile(join(stageRoot, "final", "latest-mac.yml"), "utf8"),
    ) as { files: Array<{ url: string }>; path: string };
    expect(macMetadata.files.map(({ url }) => url)).toEqual([
      ...policies["macos-x64"].packages,
      ...policies["macos-arm64"].packages,
    ]);
    expect(macMetadata.path).toBe(policies["macos-x64"].packages.at(-1));
    const resolvedMacFiles = macMetadata.files.map(({ url }) => ({
      url: new URL(url, "https://updates.example.invalid/"),
      info: { url },
    }));
    expect(findFile(
      MacUpdater.filterFilesForArch(resolvedMacFiles, false),
      "zip",
      ["pkg", "dmg"],
    )?.info.url).toBe(policies["macos-x64"].packages.at(-1));
    expect(findFile(
      MacUpdater.filterFilesForArch(resolvedMacFiles, true),
      "zip",
      ["pkg", "dmg"],
    )?.info.url).toBe(policies["macos-arm64"].packages.at(-1));

    const windowsMetadata = parse(
      await readFile(join(stageRoot, "final", "latest.yml"), "utf8"),
    ) as { files: Array<{ url: string }>; path: string };
    expect(windowsMetadata.files.map(({ url }) => url)).toEqual([
      ...policies["windows-x64"].packages,
      ...policies["windows-arm64"].packages,
    ]);
    expect(windowsMetadata.path).toBe(policies["windows-x64"].packages[0]);
    const resolvedWindowsFiles = windowsMetadata.files.map(({ url }) => ({
      url: new URL(url, "https://updates.example.invalid/"),
      info: { url },
    }));
    expect(findFile(resolvedWindowsFiles, "exe")?.info.url).toBe(
      process.arch === "arm64"
        ? policies["windows-arm64"].packages[0]
        : policies["windows-x64"].packages[0],
    );
  });

  it("rejects mixed updater capability within one shared architecture channel", async () => {
    const fixtureRoot = await temporaryDirectory();
    const sourceRoot = join(fixtureRoot, "source");
    const stageRoot = join(fixtureRoot, "stage");
    await mkdir(sourceRoot);
    for (const platform of Object.keys(policies) as Array<keyof typeof policies>) {
      await writeFixture(sourceRoot, platform, {
        delivery: platform === "windows-arm64" ? "manual" : "in-app",
      });
      const staged = runReleaseAssets(["stage", platform], {
        INERTIA_RELEASE_SOURCE_DIR: sourceRoot,
        INERTIA_RELEASE_STAGE_DIR: stageRoot,
      });
      expect(staged.status, staged.stderr).toBe(0);
    }
    const finalized = runReleaseAssets(["finalize"], {
      INERTIA_RELEASE_DOWNLOAD_DIR: stageRoot,
    });
    expect(finalized.status).not.toBe(0);
    expect(finalized.stderr).toContain(
      "latest.yml architectures disagree on update delivery capability",
    );
  });

  it("rejects a metadata path that is not an exact package filename", async () => {
    const fixtureRoot = await temporaryDirectory();
    const sourceRoot = join(fixtureRoot, "source");
    await mkdir(sourceRoot);
    await writeFixture(sourceRoot, "linux-x64", { overrideUrl: "../Inertia.AppImage" });
    const result = runReleaseAssets(["stage", "linux-x64"], {
      INERTIA_RELEASE_SOURCE_DIR: sourceRoot,
      INERTIA_RELEASE_STAGE_DIR: join(fixtureRoot, "stage"),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsafe filename");
  });

  it("rejects a packaged updater configuration for any other provider URL", async () => {
    const fixtureRoot = await temporaryDirectory();
    const sourceRoot = join(fixtureRoot, "source");
    await mkdir(sourceRoot);
    await writeFixture(sourceRoot, "windows-x64", { feedUrl: "https://example.invalid/releases" });
    const result = runReleaseAssets(["stage", "windows-x64"], {
      INERTIA_RELEASE_SOURCE_DIR: sourceRoot,
      INERTIA_RELEASE_STAGE_DIR: join(fixtureRoot, "stage"),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("approved generic feed");
  });

  it("omits updater channel assets from manual-only platform releases", async () => {
    const fixtureRoot = await temporaryDirectory();
    const sourceRoot = join(fixtureRoot, "source");
    const stageRoot = join(fixtureRoot, "stage");
    await mkdir(sourceRoot);
    await writeFixture(sourceRoot, "windows-x64", { delivery: "manual" });
    const result = runReleaseAssets(["stage", "windows-x64"], {
      INERTIA_RELEASE_SOURCE_DIR: sourceRoot,
      INERTIA_RELEASE_STAGE_DIR: stageRoot,
    });
    expect(result.status, result.stderr).toBe(0);
    expect((await readdir(join(stageRoot, "windows-x64"))).sort()).toEqual([
      `Inertia.Setup.${version}.exe`,
      "manifest.json",
    ]);
    const manifest = JSON.parse(
      await readFile(join(stageRoot, "windows-x64", "manifest.json"), "utf8"),
    ) as { updateCapability: unknown };
    expect(manifest.updateCapability).toEqual({
      delivery: "manual",
      reason: "windows-signing-unavailable",
    });
  });

  it("requires publisher identity only for signed Windows update channels", async () => {
    const fixtureRoot = await temporaryDirectory();
    const sourceRoot = join(fixtureRoot, "source");
    await mkdir(sourceRoot);
    await writeFixture(sourceRoot, "windows-x64", {
      includePublisherName: false,
    });
    const result = runReleaseAssets(["stage", "windows-x64"], {
      INERTIA_RELEASE_SOURCE_DIR: sourceRoot,
      INERTIA_RELEASE_STAGE_DIR: join(fixtureRoot, "stage"),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid publisher identity");
  });

  it("requires updater metadata to match its differential blockmap", async () => {
    const fixtureRoot = await temporaryDirectory();
    const sourceRoot = join(fixtureRoot, "source");
    await mkdir(sourceRoot);
    await writeFixture(sourceRoot, "windows-x64");
    const metadataPath = join(sourceRoot, policies["windows-x64"].metadata);
    const metadata = await readFile(metadataPath, "utf8");
    await writeFile(metadataPath, metadata.replace(/blockMapSize: \d+/u, "blockMapSize: 1"));
    const result = runReleaseAssets(["stage", "windows-x64"], {
      INERTIA_RELEASE_SOURCE_DIR: sourceRoot,
      INERTIA_RELEASE_STAGE_DIR: join(fixtureRoot, "stage"),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("blockmap size mismatch");
  });

  it("revalidates update metadata and staged hashes during consolidation", async () => {
    const fixtureRoot = await temporaryDirectory();
    const sourceRoot = join(fixtureRoot, "source");
    const stageRoot = join(fixtureRoot, "stage");
    await mkdir(sourceRoot);
    for (const platform of Object.keys(policies) as Array<keyof typeof policies>) {
      await writeFixture(sourceRoot, platform);
      const result = runReleaseAssets(["stage", platform], {
        INERTIA_RELEASE_SOURCE_DIR: sourceRoot,
        INERTIA_RELEASE_STAGE_DIR: stageRoot,
      });
      expect(result.status, result.stderr).toBe(0);
    }
    await writeFile(join(stageRoot, "linux-x64", `Inertia-${version}.AppImage`), "tampered");
    const finalized = runReleaseAssets(["finalize"], {
      INERTIA_RELEASE_DOWNLOAD_DIR: stageRoot,
    });
    expect(finalized.status).not.toBe(0);
    expect(finalized.stderr).toContain("integrity mismatch");
  });
});
