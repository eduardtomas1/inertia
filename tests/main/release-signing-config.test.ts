import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const signingEnvironmentKeys = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
] as const;

function loadConfig(
  platform: "macos-arm64" | "windows-x64" | "linux-x64",
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

describe("release signing configuration", () => {
  it("removes blank CI credential variables before electron-builder can resolve them as paths", () => {
    const blanks = Object.fromEntries(signingEnvironmentKeys.map((key) => [key, ""]));
    const result = loadConfig("macos-arm64", blanks, true);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      config: {
        forceCodeSigning: false,
        extraMetadata: {
          inertiaUpdateCapability: {
            delivery: "manual",
            reason: "macos-signing-unavailable",
          },
        },
        mac: {
          identity: "-",
          notarize: false,
        },
      },
      present: [],
    });
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

  it("requires every macOS signing and notarization secret as one set", () => {
    const partial = loadConfig("macos-arm64", { CSC_LINK: "certificate" });
    expect(partial.status).not.toBe(0);
    expect(partial.stderr).toContain("macOS signing configuration is incomplete");
    expect(partial.stderr).not.toContain("certificate");

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
      inertiaUpdateCapability: { delivery: "in-app", platform: "darwin" },
    });
    expect(complete.stdout).not.toContain("certificate");
    expect(complete.stdout).not.toContain("password");
  });

  it("fails closed on partial Windows signing configuration", () => {
    const partial = loadConfig("windows-x64", { WIN_CSC_LINK: "certificate" });
    expect(partial.status).not.toBe(0);
    expect(partial.stderr).toContain("Windows signing configuration is incomplete");

    const complete = loadConfig("windows-x64", {
      WIN_CSC_LINK: "certificate",
      WIN_CSC_KEY_PASSWORD: "password",
    });
    expect(complete.status).toBe(0);
    expect(JSON.parse(complete.stdout)).toMatchObject({
      forceCodeSigning: true,
      extraMetadata: {
        inertiaUpdateCapability: { delivery: "in-app", platform: "win32" },
      },
    });
    expect(complete.stdout).not.toContain("certificate");
    expect(complete.stdout).not.toContain("password");
  });

  it("marks only the release AppImage configuration as Linux in-app capable", () => {
    const result = loadConfig("linux-x64");
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
  });
});
