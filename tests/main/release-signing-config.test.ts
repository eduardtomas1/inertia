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
const workflowSigningEnvironmentKeys = [
  "MACOS_CSC_LINK",
  "MACOS_CSC_KEY_PASSWORD",
  "MACOS_APPLE_API_KEY_BASE64",
  "MACOS_APPLE_API_KEY_ID",
  "MACOS_APPLE_API_ISSUER",
  "WINDOWS_CSC_LINK",
  "WINDOWS_CSC_KEY_PASSWORD",
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

function validateWorkflowSigning(
  platform: "macos-arm64" | "windows-x64",
  additions: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const environment = { ...process.env };
  for (const key of workflowSigningEnvironmentKeys) delete environment[key];
  const result = spawnSync(
    process.execPath,
    ["scripts/validate-release-signing.mjs", platform],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...environment, ...additions },
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("release signing configuration", () => {
  it("removes blank CI credential variables and still fails a missing macOS release set closed", () => {
    const blanks = Object.fromEntries(signingEnvironmentKeys.map((key) => [key, ""]));
    const result = loadConfig("macos-arm64", blanks, true);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("macOS signing configuration is required and incomplete");
    expect(result.stderr).toContain("CSC_LINK");
  });

  it("requires every macOS signing and notarization secret as one set", () => {
    const partial = loadConfig("macos-arm64", { CSC_LINK: "certificate" });
    expect(partial.status).not.toBe(0);
    expect(partial.stderr).toContain("macOS signing configuration is required and incomplete");
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

  it("fails closed on missing and partial Windows signing configuration", () => {
    const missing = loadConfig("windows-x64");
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("WIN_CSC_LINK");
    expect(missing.stderr).toContain("WIN_CSC_KEY_PASSWORD");

    const partial = loadConfig("windows-x64", { WIN_CSC_LINK: "certificate" });
    expect(partial.status).not.toBe(0);
    expect(partial.stderr).toContain("Windows signing configuration is required and incomplete");

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

  it("validates complete, partial, and missing workflow secret sets without printing values", () => {
    const completeMac = validateWorkflowSigning("macos-arm64", {
      MACOS_CSC_LINK: "mac-certificate",
      MACOS_CSC_KEY_PASSWORD: "mac-password",
      MACOS_APPLE_API_KEY_BASE64: "mac-api-key",
      MACOS_APPLE_API_KEY_ID: "mac-key-id",
      MACOS_APPLE_API_ISSUER: "mac-issuer",
    });
    expect(completeMac.status).toBe(0);
    expect(completeMac.stdout).toContain("Complete macos-arm64 public-release signing configuration verified");
    expect(completeMac.stdout).not.toContain("mac-certificate");
    expect(completeMac.stdout).not.toContain("mac-password");

    const partialMac = validateWorkflowSigning("macos-arm64", {
      MACOS_CSC_LINK: "mac-certificate",
    });
    expect(partialMac.status).not.toBe(0);
    expect(partialMac.stderr).toContain("MACOS_CSC_KEY_PASSWORD");
    expect(partialMac.stderr).not.toContain("mac-certificate");

    const missingWindows = validateWorkflowSigning("windows-x64");
    expect(missingWindows.status).not.toBe(0);
    expect(missingWindows.stderr).toContain("WINDOWS_CSC_LINK");
    expect(missingWindows.stderr).toContain("WINDOWS_CSC_KEY_PASSWORD");

    const completeWindows = validateWorkflowSigning("windows-x64", {
      WINDOWS_CSC_LINK: "windows-certificate",
      WINDOWS_CSC_KEY_PASSWORD: "windows-password",
    });
    expect(completeWindows.status).toBe(0);
    expect(completeWindows.stdout).not.toContain("windows-certificate");
    expect(completeWindows.stdout).not.toContain("windows-password");
  });

  it("gives contributor CI packages a non-release identity and no update feed", () => {
    const result = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(require('./scripts/electron-builder.contributor-ci.cjs')))"],
      { cwd: root, encoding: "utf8", env: { ...process.env } },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      appId: "dev.inertia.app.contributor-ci",
      publish: [],
      extraMetadata: {
        inertiaUpdateCapability: {
          delivery: "manual",
          reason: "contributor-ci-build",
        },
      },
    });
    expect(result.stdout).not.toContain("releases/latest/download");
  });
});
