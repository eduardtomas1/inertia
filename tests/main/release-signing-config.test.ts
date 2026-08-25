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
const signingEnvironmentKeys = [
  ...macSigningEnvironmentKeys,
  ...windowsSigningEnvironmentKeys,
] as const;
const releaseChannels = ["stable", "canary"] as const;

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

function loadIncompleteMacSigningMatrix(): {
  status: number | null;
  stdout: string;
  stderr: string;
  error: string;
} {
  const environment = { ...process.env };
  for (const key of signingEnvironmentKeys) delete environment[key];
  const command = `
    const signingEnvironmentKeys = ${JSON.stringify(signingEnvironmentKeys)};
    const macSigningEnvironmentKeys = ${JSON.stringify(macSigningEnvironmentKeys)};
    const releaseChannels = ${JSON.stringify(releaseChannels)};
    const releasePlatforms = ["macos-x64", "macos-arm64"];
    const configPath = require.resolve("./scripts/electron-builder.release.cjs");
    const results = [];

    for (const channel of releaseChannels) {
      for (const platform of releasePlatforms) {
        for (let mask = 1; mask < (1 << macSigningEnvironmentKeys.length) - 1; mask += 1) {
          for (const key of signingEnvironmentKeys) delete process.env[key];
          process.env.INERTIA_RELEASE_CHANNEL = channel;
          process.env.INERTIA_RELEASE_PLATFORM = platform;
          for (const [index, key] of macSigningEnvironmentKeys.entries()) {
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
    maxBuffer: 512 * 1024,
    timeout: 5_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message ?? "",
  };
}

describe("release signing configuration", () => {
  it("removes blank CI credential variables on every channel and native architecture", () => {
    const blanks = Object.fromEntries(signingEnvironmentKeys.map((key) => [key, ""]));
    for (const channel of releaseChannels) {
      for (const platform of [
        "macos-x64",
        "macos-arm64",
        "windows-x64",
        "windows-arm64",
        "linux-x64",
        "linux-arm64",
      ] as const) {
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
    const result = loadIncompleteMacSigningMatrix();
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

  it("applies the same fail-closed macOS policy to the native Intel build", () => {
    const complete = loadConfig("macos-x64", {
      CSC_LINK: "certificate",
      CSC_KEY_PASSWORD: "password",
      APPLE_API_KEY: "/private/key.p8",
      APPLE_API_KEY_ID: "key-id",
      APPLE_API_ISSUER: "issuer",
    });
    expect(complete.status).toBe(0);
    expect(JSON.parse(complete.stdout)).toMatchObject({
      forceCodeSigning: true,
      extraMetadata: {
        inertiaUpdateCapability: { delivery: "in-app", platform: "darwin" },
      },
      mac: { hardenedRuntime: true, notarize: true },
    });
  });

  it("rejects both Windows singleton signing subsets on both channels and architectures", () => {
    let checked = 0;
    for (const channel of releaseChannels) {
      for (const platform of ["windows-x64", "windows-arm64"] as const) {
        for (const key of windowsSigningEnvironmentKeys) {
          const value = `configured-${key}`;
          const result = loadConfig(platform, {
            INERTIA_RELEASE_CHANNEL: channel,
            [key]: value,
          });
          expect(result.status, `${channel}/${platform}/${key}: ${result.stderr}`).not.toBe(0);
          expect(result.stderr).toContain("Windows signing configuration is incomplete");
          expect(result.stderr).not.toContain(value);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(8);
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

  it("marks only the release AppImage configuration as Linux in-app capable", () => {
    for (const platform of ["linux-x64", "linux-arm64"] as const) {
      const result = loadConfig(platform);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        forceCodeSigning: false,
        publish: [{
          provider: "generic",
          url: "https://github.com/eduardtomas1/inertia/releases/latest/download",
        }],
        extraMetadata: {
          inertiaUpdateCapability: { delivery: "in-app", platform: "linux" },
        },
      });
    }
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
          StartupWMClass: "Inertia Canary",
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
});
