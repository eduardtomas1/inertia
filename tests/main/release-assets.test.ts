import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { createPackage } from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  name: string;
  version: string;
};
const version = packageJson.version;
const releaseTag = `v${version}`;
const temporaryDirectories = new Set<string>();

const policies = {
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
  "linux-x64": {
    packages: [`Inertia-${version}.AppImage`],
    metadata: "latest-linux.yml",
    companions: [],
    packagedUpdateConfig: "linux-unpacked/resources/app-update.yml",
    packagedAppArchive: "linux-unpacked/resources/app.asar",
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
    feedUrl?: string;
    overrideUrl?: string;
    delivery?: "in-app" | "manual";
    includePublisherName?: boolean;
  } = {},
): Promise<void> {
  const policy = policies[platform];
  const delivery = options.delivery ?? "in-app";
  const platformMarker = {
    "macos-arm64": "darwin",
    "windows-x64": "win32",
    "linux-x64": "linux",
  }[platform];
  const manualReason = platform === "macos-arm64"
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
    name: packageJson.name,
    version,
    inertiaUpdateCapability: capability,
  }));
  await createPackage(manifestSource, archivePath);

  const updateConfigPath = join(sourceRoot, policy.packagedUpdateConfig);
  await mkdir(dirname(updateConfigPath), { recursive: true });
  const includePublisherName = options.includePublisherName
    ?? (platform === "windows-x64" && delivery === "in-app");
  await writeFile(
    updateConfigPath,
    [
      "provider: generic",
      `url: ${options.feedUrl ?? "https://github.com/eduardtomas1/inertia/releases/latest/download"}`,
      "updaterCacheDirName: inertia-updater",
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
    const expected = [
      ...Object.values(policies).flatMap((policy) => [
        ...policy.packages,
        policy.metadata,
        ...policy.companions,
      ]),
      "SHA256SUMS.txt",
    ].sort();
    expect(entries).toEqual(expected);
    const checksums = await readFile(join(stageRoot, "final", "SHA256SUMS.txt"), "utf8");
    expect(checksums.trim().split("\n")).toHaveLength(expected.length - 1);
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
