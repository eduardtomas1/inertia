import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const macSigningEnvironmentKeys = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
] as const;
const windowsSigningEnvironmentKeys = [
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
] as const;
const windowsAzureSigningEnvironmentKeys = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TRUSTED_SIGNING_ENDPOINT",
  "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
  "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
  "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
] as const;
const signingEnvironmentKeys = [
  ...macSigningEnvironmentKeys,
  ...windowsSigningEnvironmentKeys,
  ...windowsAzureSigningEnvironmentKeys,
] as const;
const azureSigning = {
  AZURE_TENANT_ID: "tenant-value-1f0c",
  AZURE_CLIENT_ID: "client-value-9a2e",
  AZURE_CLIENT_SECRET: "client-secret-value-77d1",
  AZURE_TRUSTED_SIGNING_ENDPOINT: "https://weu.codesigning.azure.net/",
  AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: "inertia-signing",
  AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME: "inertia-public-trust",
  AZURE_TRUSTED_SIGNING_PUBLISHER_NAME: "Example Publisher, Inc.",
} as const satisfies Record<(typeof windowsAzureSigningEnvironmentKeys)[number], string>;
const certificateSigning = {
  WIN_CSC_LINK: "certificate",
  WIN_CSC_KEY_PASSWORD: "password",
} as const;
const releaseChannels = ["stable", "canary"] as const;

function loadWindowsUpdateConfiguration(
  platform: "windows-x64" | "windows-arm64",
  additions: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const environment = { ...process.env };
  for (const key of signingEnvironmentKeys) delete environment[key];
  const command = `
    const { Platform } = require("app-builder-lib");
    const { WinPackager } = require("app-builder-lib/out/winPackager");
    const { WindowsSignAzureManager } = require("app-builder-lib/out/codeSign/windowsSignAzureManager");
    const { getAppUpdatePublishConfiguration } = require("app-builder-lib/out/publish/PublishManager");
    const config = require("./scripts/electron-builder.release.cjs");
    const verification = Object.getOwnPropertyDescriptor(
      WinPackager.prototype,
      "isForceCodeSigningVerification",
    ).get;
    const packager = {
      platform: Platform.WINDOWS,
      config,
      platformSpecificBuildOptions: config.win,
      info: { config, appInfo: { channel: null } },
      appInfo: { updaterCacheDirName: "inertia-updater" },
      expandMacro: (value) => value,
      get isForceCodeSigningVerification() {
        return verification.call(this);
      },
    };
    packager.signingManager = { value: Promise.resolve(new WindowsSignAzureManager(packager)) };
    getAppUpdatePublishConfiguration(packager, null, 1, false).then((updateConfiguration) => {
      process.stdout.write(JSON.stringify(updateConfiguration));
    }, (error) => {
      process.stderr.write(String(error && error.message));
      process.exitCode = 1;
    });
  `;
  const result = spawnSync(process.execPath, ["-e", command], {
    cwd: root,
    encoding: "utf8",
    env: { ...environment, INERTIA_RELEASE_PLATFORM: platform, ...additions },
    timeout: 15_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function loadConfig(
  platform:
    | "macos-x64"
    | "macos-arm64"
    | "windows-x64"
    | "windows-arm64"
    | "linux-x64"
    | "linux-arm64",
  additions: Record<string, string> = {},
  inspectEnvironment = false,
): { status: number | null; stdout: string; stderr: string } {
  const environment = { ...process.env };
  for (const key of signingEnvironmentKeys) delete environment[key];
  const command = inspectEnvironment
    ? `const config = require('./scripts/electron-builder.release.cjs');
       const present = ${JSON.stringify(signingEnvironmentKeys)}.filter((key) =>
         Object.prototype.hasOwnProperty.call(process.env, key));
       process.stdout.write(JSON.stringify({ config, present }));`
    : "process.stdout.write(JSON.stringify(require('./scripts/electron-builder.release.cjs')))";
  const result = spawnSync(
    process.execPath,
    ["-e", command],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...environment,
        INERTIA_RELEASE_PLATFORM: platform,
        ...additions,
      },
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function loadIncompleteSigningMatrix(
  releasePlatforms: readonly string[],
  subsetKeys: readonly string[],
): {
  status: number | null;
  stdout: string;
  stderr: string;
  error: string;
} {
  const environment = { ...process.env };
  for (const key of signingEnvironmentKeys) delete environment[key];
  const command = `
    const signingEnvironmentKeys = ${JSON.stringify(signingEnvironmentKeys)};
    const subsetKeys = ${JSON.stringify(subsetKeys)};
    const releaseChannels = ${JSON.stringify(releaseChannels)};
    const releasePlatforms = ${JSON.stringify(releasePlatforms)};
    const configPath = require.resolve("./scripts/electron-builder.release.cjs");
    const results = [];

    for (const channel of releaseChannels) {
      for (const platform of releasePlatforms) {
        for (let mask = 1; mask < (1 << subsetKeys.length) - 1; mask += 1) {
          for (const key of signingEnvironmentKeys) delete process.env[key];
          process.env.INERTIA_RELEASE_CHANNEL = channel;
          process.env.INERTIA_RELEASE_PLATFORM = platform;
          for (const [index, key] of subsetKeys.entries()) {
            if ((mask & (1 << index)) !== 0) process.env[key] = \`configured-\${key}\`;
          }

          delete require.cache[configPath];
          let outcome = "success";
          let diagnostic = "";
          try {
            require(configPath);
          } catch (error) {
            outcome = "error";
            diagnostic = error instanceof Error ? error.message : String(error);
          }
          results.push({ channel, platform, mask, outcome, diagnostic });
        }
      }
    }

    process.stdout.write(JSON.stringify(results));
  `;
  const result = spawnSync(process.execPath, ["-e", command], {
    cwd: root,
    encoding: "utf8",
    env: environment,
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message ?? "",
  };
}

describe("release signing configuration", () => {
  it("removes blank CI credential variables on every channel and operating system", () => {
    const blanks = Object.fromEntries(signingEnvironmentKeys.map((key) => [key, ""]));
    for (const channel of releaseChannels) {
      for (const platform of ["macos-arm64", "windows-x64", "linux-x64"] as const) {
        const result = loadConfig(platform, {
          ...blanks,
          INERTIA_RELEASE_CHANNEL: channel,
        }, true);
        expect(result.status, `${channel}/${platform}: ${result.stderr}`).toBe(0);
        const parsed = JSON.parse(result.stdout) as {
          config: {
            forceCodeSigning: boolean;
            extraMetadata: {
              inertiaReleaseChannel: string;
              inertiaUpdateCapability: unknown;
            };
          };
          present: string[];
        };
        expect(parsed.present).toEqual([]);
        expect(parsed.config.forceCodeSigning).toBe(false);
        expect(parsed.config.extraMetadata.inertiaReleaseChannel).toBe(channel);
        expect(parsed.config.extraMetadata.inertiaUpdateCapability).toEqual(
          platform.startsWith("linux-")
            ? { delivery: "in-app", platform: "linux" }
            : {
                delivery: "manual",
                reason: platform.startsWith("macos-")
                  ? "macos-signing-unavailable"
                  : "windows-signing-unavailable",
              },
        );
      }
    }
  });

  it("rejects every non-empty proper macOS signing subset on both channels and architectures", () => {
    const result = loadIncompleteSigningMatrix(["macos-x64", "macos-arm64"], macSigningEnvironmentKeys);
    expect(result.status, `${result.error}\n${result.stderr}`).toBe(0);
    expect(result.error).toBe("");
    expect(result.stderr).toBe("");
    const cases = JSON.parse(result.stdout) as Array<{
      channel: string;
      platform: string;
      mask: number;
      outcome: "success" | "error";
      diagnostic: string;
    }>;
    expect(cases).toHaveLength(120);

    let checked = 0;
    for (const channel of releaseChannels) {
      for (const platform of ["macos-x64", "macos-arm64"] as const) {
        for (let mask = 1; mask < (1 << macSigningEnvironmentKeys.length) - 1; mask += 1) {
          const testCase = cases[checked];
          expect(testCase).toMatchObject({ channel, platform, mask, outcome: "error" });
          const missingKeys = macSigningEnvironmentKeys.filter(
            (_key, index) => (mask & (1 << index)) === 0,
          );
          expect(
            testCase.diagnostic,
            `${channel}/${platform}/subset-${mask}`,
          ).toBe(
            `macOS signing configuration is incomplete. Missing: ${missingKeys.join(", ")}.`,
          );
          for (const key of macSigningEnvironmentKeys) {
            expect(testCase.diagnostic).not.toContain(`configured-${key}`);
          }
          checked += 1;
        }
      }
    }
    expect(checked).toBe(120);
  });

  it("keeps credential-free macOS builds explicit and reproducible", () => {
    const result = loadConfig("macos-arm64");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      forceCodeSigning: false,
      publish: [{
        provider: "generic",
        url: "https://github.com/eduardtomas1/inertia/releases/latest/download",
      }],
      extraMetadata: {
        desktopName: "dev.inertia.app.desktop",
        inertiaReleaseChannel: "stable",
        inertiaUpdateCapability: {
          delivery: "manual",
          reason: "macos-signing-unavailable",
        },
      },
      mac: {
        identity: "-",
        hardenedRuntime: true,
        notarize: false,
      },
    });
  });

  it("accepts the complete macOS signing and notarization set", () => {
    const complete = loadConfig("macos-arm64", {
      CSC_LINK: "certificate",
      CSC_KEY_PASSWORD: "password",
      APPLE_API_KEY: "/private/key.p8",
      APPLE_API_KEY_ID: "key-id",
      APPLE_API_ISSUER: "issuer",
    });
    expect(complete.status).toBe(0);
    const config = JSON.parse(complete.stdout) as {
      forceCodeSigning: boolean;
      extraMetadata: Record<string, unknown>;
      mac: { identity?: string; hardenedRuntime: boolean; notarize: boolean };
    };
    expect(config.forceCodeSigning).toBe(true);
    expect(config.mac.identity).toBeUndefined();
    expect(config.mac.hardenedRuntime).toBe(true);
    expect(config.mac.notarize).toBe(true);
    expect(config.extraMetadata).toEqual({
      desktopName: "dev.inertia.app.desktop",
      inertiaReleaseChannel: "stable",
      inertiaUpdateCapability: { delivery: "in-app", platform: "darwin" },
    });
    expect(complete.stdout).not.toContain("certificate");
    expect(complete.stdout).not.toContain("password");
  });

  it("rejects both Windows singleton signing subsets", () => {
    for (const key of windowsSigningEnvironmentKeys) {
      const value = `configured-${key}`;
      const result = loadConfig("windows-x64", { [key]: value });
      expect(result.status, `${key}: ${result.stderr}`).not.toBe(0);
      expect(result.stderr).toContain("Windows signing configuration is incomplete");
      expect(result.stderr).not.toContain(value);
    }
    expect(windowsSigningEnvironmentKeys).toHaveLength(2);
  });

  it("accepts the complete Windows signing configuration", () => {
    const complete = loadConfig("windows-x64", {
      WIN_CSC_LINK: "certificate",
      WIN_CSC_KEY_PASSWORD: "password",
    });
    expect(complete.status).toBe(0);
    expect(JSON.parse(complete.stdout)).toMatchObject({
      forceCodeSigning: true,
      extraMetadata: {
        desktopName: "dev.inertia.app.desktop",
        inertiaReleaseChannel: "stable",
        inertiaUpdateCapability: { delivery: "in-app", platform: "win32" },
      },
    });
    expect(complete.stdout).not.toContain("certificate");
    expect(complete.stdout).not.toContain("password");
  });

  it("gives the signed ARM64 Windows installer a collision-free name", () => {
    const complete = loadConfig("windows-arm64", {
      WIN_CSC_LINK: "certificate",
      WIN_CSC_KEY_PASSWORD: "password",
    });
    expect(complete.status).toBe(0);
    expect(JSON.parse(complete.stdout)).toMatchObject({
      forceCodeSigning: true,
      extraMetadata: {
        inertiaUpdateCapability: { delivery: "in-app", platform: "win32" },
      },
      win: {
        artifactName: "Inertia.Setup.${version}.arm64.${ext}",
      },
    });
  });

  it("builds Canary as a separate application, feed, cache lineage, executable, and artifact set", () => {
    const result = loadConfig("linux-x64", {
      INERTIA_RELEASE_CHANNEL: "canary",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      appId: "dev.inertia.app.canary",
      productName: "Inertia Canary",
      publish: [{
        provider: "generic",
        url: "https://raw.githubusercontent.com/eduardtomas1/inertia/canary-feed",
        channel: "canary",
      }],
      extraMetadata: {
        name: "inertia-canary",
        desktopName: "dev.inertia.app.desktop.canary",
        inertiaReleaseChannel: "canary",
        inertiaUpdateCapability: { delivery: "in-app", platform: "linux" },
      },
      linux: {
        artifactName: "Inertia-Canary-${version}.${ext}",
        executableName: "inertia-canary",
        desktop: { entry: {
          Name: "Inertia Canary",
          StartupWMClass: "dev.inertia.app.desktop.canary",
        } },
      },
    });
  });

  it("keeps six-target Canary artifacts disjoint without changing unsigned desktop delivery", () => {
    const expectedArtifacts = {
      "macos-x64": "Inertia-Canary-${version}-${arch}.${ext}",
      "macos-arm64": "Inertia-Canary-${version}-${arch}.${ext}",
      "windows-x64": "Inertia.Canary.Setup.${version}.${ext}",
      "windows-arm64": "Inertia.Canary.Setup.${version}.arm64.${ext}",
      "linux-x64": "Inertia-Canary-${version}.${ext}",
      "linux-arm64": "Inertia-Canary-${version}-arm64.${ext}",
    } as const;
    for (const [platform, artifactName] of Object.entries(expectedArtifacts) as Array<
      [keyof typeof expectedArtifacts, string]
    >) {
      const result = loadConfig(platform, { INERTIA_RELEASE_CHANNEL: "canary" });
      expect(result.status, result.stderr).toBe(0);
      const config = JSON.parse(result.stdout) as {
        extraMetadata: { inertiaUpdateCapability: { delivery: string; reason?: string } };
        linux?: { artifactName: string };
        mac?: { artifactName: string };
        win?: { artifactName: string };
      };
      expect(config[platform.startsWith("macos-")
        ? "mac"
        : platform.startsWith("windows-")
          ? "win"
          : "linux"]?.artifactName).toBe(artifactName);
      if (platform.startsWith("macos-") || platform.startsWith("windows-")) {
        expect(config.extraMetadata.inertiaUpdateCapability).toMatchObject({
          delivery: "manual",
          reason: platform.startsWith("macos-")
            ? "macos-signing-unavailable"
            : "windows-signing-unavailable",
        });
      } else {
        expect(config.extraMetadata.inertiaUpdateCapability)
          .toEqual({ delivery: "in-app", platform: "linux" });
      }
    }
  });

  it("rejects every non-empty proper Azure Trusted Signing subset on both channels and architectures", () => {
    const result = loadIncompleteSigningMatrix(
      ["windows-x64", "windows-arm64"],
      windowsAzureSigningEnvironmentKeys,
    );
    expect(result.status, `${result.error}\n${result.stderr}`).toBe(0);
    expect(result.error).toBe("");
    expect(result.stderr).toBe("");
    const cases = JSON.parse(result.stdout) as Array<{
      channel: string;
      platform: string;
      mask: number;
      outcome: "success" | "error";
      diagnostic: string;
    }>;
    const subsets = (1 << windowsAzureSigningEnvironmentKeys.length) - 2;
    expect(cases).toHaveLength(subsets * 4);

    let checked = 0;
    for (const channel of releaseChannels) {
      for (const platform of ["windows-x64", "windows-arm64"] as const) {
        for (let mask = 1; mask <= subsets; mask += 1) {
          const testCase = cases[checked];
          expect(testCase).toMatchObject({ channel, platform, mask, outcome: "error" });
          const missingKeys = windowsAzureSigningEnvironmentKeys.filter(
            (_key, index) => (mask & (1 << index)) === 0,
          );
          expect(testCase.diagnostic, `${channel}/${platform}/subset-${mask}`).toBe(
            `Windows Azure Trusted Signing configuration is incomplete. Missing: ${missingKeys.join(", ")}.`,
          );
          expect(testCase.diagnostic).not.toContain("configured-");
          checked += 1;
        }
      }
    }
    expect(checked).toBe(subsets * 4);
  });

  it("accepts the complete Azure Trusted Signing set as signed in-app Windows delivery", () => {
    for (const channel of releaseChannels) {
      for (const platform of ["windows-x64", "windows-arm64"] as const) {
        const result = loadConfig(platform, { ...azureSigning, INERTIA_RELEASE_CHANNEL: channel });
        expect(result.status, `${channel}/${platform}: ${result.stderr}`).toBe(0);
        const config = JSON.parse(result.stdout) as {
          forceCodeSigning: boolean;
          extraMetadata: { inertiaUpdateCapability: unknown };
          win: { azureSignOptions?: unknown; verifyUpdateCodeSignature?: boolean; signtoolOptions?: unknown };
        };
        expect(config.forceCodeSigning).toBe(true);
        expect(config.extraMetadata.inertiaUpdateCapability)
          .toEqual({ delivery: "in-app", platform: "win32" });
        expect(config.win.verifyUpdateCodeSignature).toBe(true);
        expect(config.win.signtoolOptions).toBeUndefined();
        expect(config.win.azureSignOptions).toEqual({
          publisherName: "Example Publisher, Inc.",
          endpoint: "https://weu.codesigning.azure.net/",
          codeSigningAccountName: "inertia-signing",
          certificateProfileName: "inertia-public-trust",
        });
        for (const secret of [
          azureSigning.AZURE_TENANT_ID,
          azureSigning.AZURE_CLIENT_ID,
          azureSigning.AZURE_CLIENT_SECRET,
        ]) {
          expect(result.stdout).not.toContain(secret);
        }
      }
    }
  });

  it("rejects a Windows build that configures both the certificate file and Azure Trusted Signing", () => {
    const result = loadConfig("windows-x64", { ...certificateSigning, ...azureSigning });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Windows signing configuration is ambiguous. Configure either WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD or Azure Trusted Signing, not both.",
    );
    for (const value of [...Object.values(certificateSigning), ...Object.values(azureSigning)]) {
      expect(result.stderr).not.toContain(value);
    }
  });

  it("reports a partial Azure set even when the certificate file set is complete", () => {
    const result = loadConfig("windows-x64", {
      ...certificateSigning,
      AZURE_CLIENT_SECRET: azureSigning.AZURE_CLIENT_SECRET,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Windows Azure Trusted Signing configuration is incomplete. Missing: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_TRUSTED_SIGNING_ENDPOINT",
    );
    expect(result.stderr).not.toContain(azureSigning.AZURE_CLIENT_SECRET);
  });

  it("rejects malformed Azure Trusted Signing values without echoing them", () => {
    const cases = [
      ["AZURE_TRUSTED_SIGNING_ENDPOINT", "http://weu.codesigning.azure.net/"],
      ["AZURE_TRUSTED_SIGNING_ENDPOINT", "https://weu.codesigning.azure.net/path"],
      ["AZURE_TRUSTED_SIGNING_ENDPOINT", "https://user:pass@weu.codesigning.azure.net/"],
      ["AZURE_TRUSTED_SIGNING_ENDPOINT", "https://weu.codesigning.azure.net/?q=leak"],
      ["AZURE_TRUSTED_SIGNING_ENDPOINT", "not a url"],
      ["AZURE_TRUSTED_SIGNING_ACCOUNT_NAME", "inertia signing"],
      ["AZURE_TRUSTED_SIGNING_ACCOUNT_NAME", "inertia';Invoke-Leak;'"],
      ["AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME", "-profile"],
      ["AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME", "p".repeat(101)],
      ["AZURE_TRUSTED_SIGNING_PUBLISHER_NAME", " Example Publisher"],
      ["AZURE_TRUSTED_SIGNING_PUBLISHER_NAME", "CN=Example Publisher"],
      ["AZURE_TRUSTED_SIGNING_PUBLISHER_NAME", "Example\u0007Publisher"],
      ["AZURE_TRUSTED_SIGNING_PUBLISHER_NAME", "x".repeat(513)],
    ] as const;
    for (const [key, value] of cases) {
      const result = loadConfig("windows-x64", { ...azureSigning, [key]: value });
      expect(result.status, `${key}=${value}`).not.toBe(0);
      expect(result.stderr).toContain(
        `Windows Azure Trusted Signing configuration has an invalid ${key}.`,
      );
      expect(result.stderr).not.toContain(value);
      expect(result.stderr).not.toContain(azureSigning.AZURE_CLIENT_SECRET);
    }
  });

  it("keeps unsigned and certificate-file Windows builds free of Azure options with update verification on", () => {
    const unsigned = loadConfig("windows-x64");
    expect(unsigned.status, unsigned.stderr).toBe(0);
    const unsignedConfig = JSON.parse(unsigned.stdout) as {
      forceCodeSigning: boolean;
      extraMetadata: { inertiaUpdateCapability: unknown };
      win: { azureSignOptions?: unknown; verifyUpdateCodeSignature?: boolean };
    };
    expect(unsignedConfig.forceCodeSigning).toBe(false);
    expect(unsignedConfig.extraMetadata.inertiaUpdateCapability)
      .toEqual({ delivery: "manual", reason: "windows-signing-unavailable" });
    expect(unsignedConfig.win.verifyUpdateCodeSignature).toBe(true);
    expect(unsignedConfig.win.azureSignOptions).toBeUndefined();

    const certificate = loadConfig("windows-x64", certificateSigning);
    expect(certificate.status, certificate.stderr).toBe(0);
    const config = JSON.parse(certificate.stdout) as {
      extraMetadata: { inertiaUpdateCapability: unknown };
      win: { azureSignOptions?: unknown; verifyUpdateCodeSignature?: boolean; signtoolOptions?: unknown };
    };
    expect(config.extraMetadata.inertiaUpdateCapability).toEqual({ delivery: "in-app", platform: "win32" });
    expect(config.win.verifyUpdateCodeSignature).toBe(true);
    expect(config.win.azureSignOptions).toBeUndefined();
    expect(config.win.signtoolOptions).toBeUndefined();
  });

  it("ignores Windows credential sets on macOS and Linux builds", () => {
    for (const platform of ["macos-arm64", "linux-x64"] as const) {
      const result = loadConfig(platform, {
        ...certificateSigning,
        ...azureSigning,
        AZURE_CLIENT_SECRET: "",
      });
      expect(result.status, `${platform}: ${result.stderr}`).toBe(0);
      const config = JSON.parse(result.stdout) as {
        forceCodeSigning: boolean;
        win: { azureSignOptions?: unknown };
      };
      expect(config.forceCodeSigning).toBe(false);
      expect(config.win.azureSignOptions).toBeUndefined();
    }
  });

  it("writes the Azure publisher name into the packaged Windows update configuration", () => {
    for (const platform of ["windows-x64", "windows-arm64"] as const) {
      const result = loadWindowsUpdateConfiguration(platform, azureSigning);
      expect(result.status, `${platform}: ${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        provider: "generic",
        url: "https://github.com/eduardtomas1/inertia/releases/latest/download",
        updaterCacheDirName: "inertia-updater",
        publisherName: ["Example Publisher, Inc."],
      });
      expect(result.stdout).not.toContain(azureSigning.AZURE_CLIENT_SECRET);
    }
  });
});
