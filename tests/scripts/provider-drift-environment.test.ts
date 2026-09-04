import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  providerDriftEnvironment,
  providerDriftEnvironmentDirectories,
  prepareProviderDriftEnvironment,
} from "../../scripts/provider-drift-environment.mjs";

describe("provider drift environment isolation", () => {
  it("inherits only execution primitives and prepares isolated profile roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-provider-environment-"));
    const parentHome = join(root, "parent-home");
    const isolatedRoot = join(root, "isolated");
    mkdirSync(parentHome);
    mkdirSync(isolatedRoot, { mode: 0o777 });
    chmodSync(isolatedRoot, 0o777);
    if (process.platform !== "win32") {
      writeFileSync(join(isolatedRoot, "npmrc"), "stale-parent-config", { mode: 0o666 });
    }
    writeFileSync(join(parentHome, ".provider-credential"), "must not load");
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    try {
      const environment = providerDriftEnvironment(isolatedRoot, {
        ANTHROPIC_API_KEY: "anthropic-secret",
        AWS_ACCESS_KEY_ID: "aws-secret",
        AWS_SECRET_ACCESS_KEY: "aws-secret-key",
        GITHUB_TOKEN: "github-secret",
        HOME: parentHome,
        KIMI_CODE_API_KEY: "kimi-secret",
        NODE_OPTIONS: "--require=/must-not-load.js",
        NPM_TOKEN: "npm-secret",
        OPENAI_API_KEY: "openai-secret",
        PATH: process.env.PATH,
        SSH_AUTH_SOCK: join(root, "parent-agent.sock"),
        SystemRoot: systemRoot,
      });
      for (const name of [
        "ANTHROPIC_API_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "GITHUB_TOKEN",
        "KIMI_CODE_API_KEY",
        "NODE_OPTIONS",
        "NPM_TOKEN",
        "OPENAI_API_KEY",
        "SSH_AUTH_SOCK",
      ]) expect(environment).not.toHaveProperty(name);
      expect(environment.PATH).toBe(process.env.PATH);
      expect(environment.SystemRoot).toBe(systemRoot);
      expect(environment.HOME).toBe(join(isolatedRoot, "home"));
      expect(environment.USERPROFILE).toBe(environment.HOME);

      await prepareProviderDriftEnvironment(isolatedRoot, environment);
      expect(readFileSync(join(isolatedRoot, "npmrc"), "utf8")).toBe("");
      if (process.platform !== "win32") {
        expect(lstatSync(isolatedRoot).mode & 0o077).toBe(0);
        expect(lstatSync(join(isolatedRoot, "npmrc")).mode & 0o077).toBe(0);
        for (const path of providerDriftEnvironmentDirectories(environment)) {
          expect(lstatSync(path).mode & 0o077).toBe(0);
        }
      }
      const observation = JSON.parse(execFileSync(process.execPath, [
        "-e",
        [
          'const { existsSync } = require("node:fs");',
          'const { join } = require("node:path");',
          "process.stdout.write(JSON.stringify({",
          "  home: process.env.HOME,",
          '  parentCredentialVisible: existsSync(join(process.env.HOME, ".provider-credential")),',
          "}));",
        ].join(""),
      ], { encoding: "utf8", env: environment })) as {
        home: string;
        parentCredentialVisible: boolean;
      };
      expect(observation).toEqual({
        home: join(isolatedRoot, "home"),
        parentCredentialVisible: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects a reused profile-root symlink before writing config",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "inertia-provider-symlink-"));
      const outside = join(root, "outside");
      const isolatedRoot = join(root, "isolated");
      mkdirSync(outside);
      symlinkSync(outside, isolatedRoot);
      try {
        const environment = providerDriftEnvironment(isolatedRoot, process.env);
        await expect(prepareProviderDriftEnvironment(isolatedRoot, environment))
          .rejects.toThrow("not owner-private");
        expect(existsSync(join(outside, "npmrc"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a reused npm profile symlink without changing its target",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "inertia-provider-npmrc-symlink-"));
      const isolatedRoot = join(root, "isolated");
      const outsideConfig = join(root, "outside-npmrc");
      mkdirSync(isolatedRoot);
      writeFileSync(outsideConfig, "outside-config");
      symlinkSync(outsideConfig, join(isolatedRoot, "npmrc"));
      try {
        const environment = providerDriftEnvironment(isolatedRoot, process.env);
        await expect(prepareProviderDriftEnvironment(isolatedRoot, environment))
          .rejects.toMatchObject({ code: "ELOOP" });
        expect(readFileSync(outsideConfig, "utf8")).toBe("outside-config");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects a profile path redirected outside the isolated root before mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-provider-profile-path-"));
    const isolatedRoot = join(root, "isolated");
    const outsideConfig = join(root, "outside-npmrc");
    mkdirSync(isolatedRoot);
    writeFileSync(outsideConfig, "outside-config", { mode: 0o666 });
    const originalMode = lstatSync(outsideConfig).mode;
    try {
      const environment = providerDriftEnvironment(isolatedRoot, process.env);
      environment.NPM_CONFIG_USERCONFIG = outsideConfig;
      await expect(prepareProviderDriftEnvironment(isolatedRoot, environment))
        .rejects.toThrow("profile paths must remain isolated");
      expect(readFileSync(outsideConfig, "utf8")).toBe("outside-config");
      expect(lstatSync(outsideConfig).mode).toBe(originalMode);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")(
    "never follows or truncates an existing Windows npm profile path",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "inertia-provider-windows-npmrc-"));
      const isolatedRoot = join(root, "isolated");
      const npmConfig = join(isolatedRoot, "npmrc");
      mkdirSync(isolatedRoot);
      writeFileSync(npmConfig, "existing-config");
      try {
        const environment = providerDriftEnvironment(isolatedRoot, process.env);
        await expect(prepareProviderDriftEnvironment(isolatedRoot, environment))
          .rejects.toThrow("Windows npm profile path must be newly created");
        expect(readFileSync(npmConfig, "utf8")).toBe("existing-config");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
