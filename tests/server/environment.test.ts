import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PROVIDER_ROUTING_ENVIRONMENT_KEYS } from "../../src/node/provider-routing-environment";
import {
  credentialFreeProviderEnvironment,
  executableCandidates,
  expandHomePath,
  loginShellEnvironment,
  providerChildEnvironment,
  providerEnvironment,
} from "../../src/server/environment";
import { portableNodeExecutable } from "../helpers/portable-provider-fixture";

const ENVIRONMENT_KEYS = [
  "ALL_PROXY",
  "ANTHROPIC_API_KEY",
  "APPDATA",
  "AWS_SECRET_ACCESS_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CODEX_HOME",
  "CURSOR_API_KEY",
  "DATABASE_URL",
  "GITHUB_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "HOME",
  "HTTPS_PROXY",
  "INERTIA_LOGIN_SHELL_MARKER",
  "KIMI_API_KEY",
  "LOCALAPPDATA",
  "NVM_BIN",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_CONFIG",
  "PATH",
  "SHELL",
  "SSL_CERT_FILE",
  "VERTEX_LOCATION",
  "USERPROFILE",
  "ZDOTDIR",
] as const;

describe.sequential("provider environment discovery", () => {
  const roots: string[] = [];
  const originalEnvironment = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));

  function temporaryRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "inertia-environment-"));
    roots.push(root);
    return root;
  }

  function executable(root: string, name: string): string {
    return portableNodeExecutable(root, name);
  }

  function setEnvironment(values: Partial<Record<(typeof ENVIRONMENT_KEYS)[number], string>>): void {
    for (const key of ENVIRONMENT_KEYS) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  afterEach(async () => {
    for (const key of ENVIRONMENT_KEYS) {
      const value = originalEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
    await providerEnvironment(true);
  });

  it("does not execute arbitrary login-shell startup files", async () => {
    const home = temporaryRoot();
    const marker = join(home, "login-shell-ran");
    const shell = join(home, "zsh");
    writeFileSync(shell, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    setEnvironment({ HOME: home, SHELL: shell, PATH: "/usr/bin:/bin" });

    await expect(loginShellEnvironment()).resolves.toEqual({});
    await providerEnvironment(true);
    expect(() => realpathSync.native(marker)).toThrow();
  });

  it("searches known per-user CLI directories when the shell PATH is minimal", async () => {
    const home = temporaryRoot();
    const localBin = process.platform === "win32" ? join(home, "npm") : join(home, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    const command = executable(localBin, "known-path-agent");

    setEnvironment({ APPDATA: home, HOME: home, PATH: home, SHELL: process.env.SHELL, USERPROFILE: home });
    const environment = await providerEnvironment(true);
    const candidates = await executableCandidates("known-path-agent", environment, home);

    expect(environment.pathEntries).toContain(localBin);
    expect(candidates).toEqual([realpathSync.native(command)]);
  });

  it.skipIf(process.platform === "win32")(
    "searches reviewed version-manager directories without running a shell",
    async () => {
      const home = temporaryRoot();
      const voltaBin = join(home, ".volta", "bin");
      const nvmBin = join(home, ".nvm", "versions", "node", "v22.18.0", "bin");
      mkdirSync(voltaBin, { recursive: true });
      mkdirSync(nvmBin, { recursive: true });
      const voltaCommand = executable(voltaBin, "volta-agent");
      const nvmCommand = executable(nvmBin, "nvm-agent");

      setEnvironment({ HOME: home, PATH: "/usr/bin:/bin" });
      const environment = await providerEnvironment(true);

      expect(environment.pathEntries).toContain(voltaBin);
      expect(environment.pathEntries).toContain(nvmBin);
      await expect(executableCandidates(
        "volta-agent",
        environment,
        home,
      )).resolves.toEqual([realpathSync.native(voltaCommand)]);
      await expect(executableCandidates(
        "nvm-agent",
        environment,
        home,
      )).resolves.toEqual([realpathSync.native(nvmCommand)]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "prioritizes active, default, and newest NVM versions within the scan bound",
    async () => {
      const home = temporaryRoot();
      const versionsRoot = join(home, ".nvm", "versions", "node");
      for (let major = 1; major <= 40; major += 1) {
        mkdirSync(join(versionsRoot, `v${major}.0.0`, "bin"), { recursive: true });
      }
      const activeBin = join(versionsRoot, "v3.0.0", "bin");
      const defaultBin = join(versionsRoot, "v2.0.0", "bin");
      const newestBin = join(versionsRoot, "v40.0.0", "bin");
      const activeCommand = executable(activeBin, "nvm-active-agent");
      const defaultCommand = executable(defaultBin, "nvm-default-agent");
      const newestCommand = executable(newestBin, "nvm-newest-agent");
      mkdirSync(join(home, ".nvm", "alias"), { recursive: true });
      writeFileSync(join(home, ".nvm", "alias", "default"), "2\n");

      setEnvironment({ HOME: home, NVM_BIN: activeBin, PATH: "/usr/bin:/bin" });
      const environment = await providerEnvironment(true);
      const scannedNvmBins = environment.pathEntries.filter(
        (entry) => entry.startsWith(`${versionsRoot}/`),
      );

      expect(scannedNvmBins).toHaveLength(32);
      expect(scannedNvmBins.slice(0, 3)).toEqual([
        activeBin,
        defaultBin,
        newestBin,
      ]);
      expect(scannedNvmBins).not.toContain(join(versionsRoot, "v1.0.0", "bin"));
      await expect(executableCandidates(
        "nvm-active-agent",
        environment,
        home,
      )).resolves.toEqual([realpathSync.native(activeCommand)]);
      await expect(executableCandidates(
        "nvm-default-agent",
        environment,
        home,
      )).resolves.toEqual([realpathSync.native(defaultCommand)]);
      await expect(executableCandidates(
        "nvm-newest-agent",
        environment,
        home,
      )).resolves.toEqual([realpathSync.native(newestCommand)]);
    },
  );

  it.skipIf(process.platform === "win32")("ignores non-executable and malformed command candidates", async () => {
    const root = temporaryRoot();
    const nonExecutable = join(root, "not-executable");
    writeFileSync(nonExecutable, "plain text");
    const environment = { env: { PATH: root }, pathEntries: [root] };

    await expect(executableCandidates("not-executable", environment, root)).resolves.toEqual([]);
    await expect(executableCandidates("bad\0command", environment, root)).resolves.toEqual([]);
  });

  it("passes only provider-owned credentials into provider children", () => {
    const source = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ANTHROPIC_API_KEY: "anthropic-secret",
      OPENAI_API_KEY: "openai-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      GITHUB_TOKEN: "github-secret",
      INERTIA_LOGIN_SHELL_MARKER: "shell-export",
    };

    expect(providerChildEnvironment("claude", source)).toMatchObject({
      PATH: source.PATH,
      HOME: source.HOME,
      ANTHROPIC_API_KEY: "anthropic-secret",
    });
    expect(providerChildEnvironment("claude", source)).not.toHaveProperty(
      "OPENAI_API_KEY",
    );
    expect(providerChildEnvironment("claude", source)).not.toHaveProperty(
      "AWS_SECRET_ACCESS_KEY",
    );
    expect(providerChildEnvironment("claude", source)).not.toHaveProperty(
      "GITHUB_TOKEN",
    );
    expect(providerChildEnvironment("claude", source)).not.toHaveProperty(
      "INERTIA_LOGIN_SHELL_MARKER",
    );
  });

  it("recognizes every outer-boundary provider routing control", () => {
    const source = Object.fromEntries(
      PROVIDER_ROUTING_ENVIRONMENT_KEYS.map((key) => [key, "1"]),
    );
    const retained = new Set(
      (["codex", "claude", "opencode"] as const).flatMap((providerId) =>
        Object.keys(providerChildEnvironment(providerId, source))),
    );

    expect(PROVIDER_ROUTING_ENVIRONMENT_KEYS.filter(
      (key) => !retained.has(key),
    )).toEqual([]);
  });

  it("keeps desktop-session launch authority out of provider children", () => {
    const environment = providerChildEnvironment("claude", {
      PATH: "/usr/bin:/bin",
      HOME: "/home/fixture",
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      BROWSER: "/tmp/provider-controlled-browser",
      ANTHROPIC_API_KEY: "anthropic-secret",
    });

    expect(environment).toMatchObject({
      PATH: "/usr/bin:/bin",
      HOME: "/home/fixture",
      ANTHROPIC_API_KEY: "anthropic-secret",
    });
    expect(environment).not.toHaveProperty("DISPLAY");
    expect(environment).not.toHaveProperty("WAYLAND_DISPLAY");
    expect(environment).not.toHaveProperty("XDG_RUNTIME_DIR");
    expect(environment).not.toHaveProperty("DBUS_SESSION_BUS_ADDRESS");
    expect(environment).not.toHaveProperty("BROWSER");
  });

  it("builds credential-free installation probe environments", () => {
    const environment = credentialFreeProviderEnvironment({
      PATH: "/usr/bin:/bin",
      PATHEXT: ".EXE;.CMD",
      SYSTEMROOT: "C:\\Windows",
      LANG: "en_US.UTF-8",
      LC_MESSAGES: "en_US.UTF-8",
      HOME: "/private/home",
      APPDATA: "C:\\private\\appdata",
      HTTPS_PROXY: "https://user:password@proxy.example",
      NODE_EXTRA_CA_CERTS: "/private/provider-ca.pem",
      OPENAI_API_KEY: "openai-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
    });

    expect(environment).toMatchObject({
      PATH: "/usr/bin:/bin",
      PATHEXT: ".EXE;.CMD",
      SYSTEMROOT: "C:\\Windows",
      LANG: "en_US.UTF-8",
      LC_MESSAGES: "en_US.UTF-8",
      NO_COLOR: "1",
    });
    expect(environment).not.toHaveProperty("HOME");
    expect(environment).not.toHaveProperty("APPDATA");
    expect(environment).not.toHaveProperty("HTTPS_PROXY");
    expect(environment).not.toHaveProperty("NODE_EXTRA_CA_CERTS");
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("expands Codex's leading home shorthand before a shell-free launch", () => {
    const codexHome = "~/.codex-work";

    expect(expandHomePath(codexHome)).toBe(join(homedir(), ".codex-work"));
    expect(expandHomePath("~\\.codex-work")).toBe(join(homedir(), ".codex-work"));
    expect(expandHomePath("~other/.codex-work")).toBe("~other/.codex-work");
    expect(providerChildEnvironment("codex", {
      PATH: process.env.PATH,
      CODEX_HOME: codexHome,
    })).toMatchObject({
      CODEX_HOME: expandHomePath(codexHome),
    });
    expect(providerChildEnvironment("claude", {
      PATH: process.env.PATH,
      CODEX_HOME: codexHome,
    })).not.toHaveProperty("CODEX_HOME");
  });

  it("passes Kimi's documented credentials and proxy without unrelated secrets", () => {
    const source = {
      PATH: process.env.PATH,
      KIMI_API_KEY: "kimi-secret",
      GOOGLE_APPLICATION_CREDENTIALS: "/run/secrets/google-adc.json",
      ALL_PROXY: "socks5://127.0.0.1:1080",
      GITHUB_TOKEN: "unrelated-github-token",
      DATABASE_URL: "postgres://unrelated-secret",
    };

    expect(providerChildEnvironment("kimi", source)).toMatchObject({
      PATH: source.PATH,
      KIMI_API_KEY: source.KIMI_API_KEY,
      GOOGLE_APPLICATION_CREDENTIALS: source.GOOGLE_APPLICATION_CREDENTIALS,
      ALL_PROXY: source.ALL_PROXY,
    });
    expect(providerChildEnvironment("kimi", source)).not.toHaveProperty("GITHUB_TOKEN");
    expect(providerChildEnvironment("kimi", source)).not.toHaveProperty("DATABASE_URL");
  });

  it("passes documented OpenCode cloud-provider authentication without unrelated secrets", () => {
    const source = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      AWS_ACCESS_KEY_ID: "bedrock-access",
      AWS_SECRET_ACCESS_KEY: "bedrock-secret",
      AWS_SESSION_TOKEN: "bedrock-session",
      AWS_PROFILE: "bedrock-profile",
      AWS_REGION: "eu-west-1",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-bearer",
      AWS_WEB_IDENTITY_TOKEN_FILE: "/run/secrets/aws-token",
      AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/inertia",
      GOOGLE_APPLICATION_CREDENTIALS: "/run/secrets/vertex.json",
      GOOGLE_CLOUD_PROJECT: "vertex-project",
      VERTEX_LOCATION: "europe-west4",
      AZURE_RESOURCE_NAME: "azure-openai",
      CLOUDFLARE_API_TOKEN: "cloudflare-token",
      DIGITALOCEAN_ACCESS_TOKEN: "digitalocean-token",
      GITLAB_TOKEN: "gitlab-token",
      SNOWFLAKE_CORTEX_TOKEN: "snowflake-token",
      GITHUB_TOKEN: "unrelated-github-token",
      DATABASE_URL: "postgres://unrelated-secret",
      STRIPE_API_KEY: "unrelated-stripe-secret",
      AWS_UNRELATED_SECRET: "unrelated-aws-secret",
      GOOGLE_UNRELATED_TOKEN: "unrelated-google-token",
    };

    expect(providerChildEnvironment("opencode", source)).toMatchObject({
      AWS_ACCESS_KEY_ID: source.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: source.AWS_SECRET_ACCESS_KEY,
      AWS_SESSION_TOKEN: source.AWS_SESSION_TOKEN,
      AWS_PROFILE: source.AWS_PROFILE,
      AWS_REGION: source.AWS_REGION,
      AWS_BEARER_TOKEN_BEDROCK: source.AWS_BEARER_TOKEN_BEDROCK,
      AWS_WEB_IDENTITY_TOKEN_FILE: source.AWS_WEB_IDENTITY_TOKEN_FILE,
      AWS_ROLE_ARN: source.AWS_ROLE_ARN,
      GOOGLE_APPLICATION_CREDENTIALS:
        source.GOOGLE_APPLICATION_CREDENTIALS,
      GOOGLE_CLOUD_PROJECT: source.GOOGLE_CLOUD_PROJECT,
      VERTEX_LOCATION: source.VERTEX_LOCATION,
      AZURE_RESOURCE_NAME: source.AZURE_RESOURCE_NAME,
      CLOUDFLARE_API_TOKEN: source.CLOUDFLARE_API_TOKEN,
      DIGITALOCEAN_ACCESS_TOKEN: source.DIGITALOCEAN_ACCESS_TOKEN,
      GITLAB_TOKEN: source.GITLAB_TOKEN,
      SNOWFLAKE_CORTEX_TOKEN: source.SNOWFLAKE_CORTEX_TOKEN,
    });
    expect(providerChildEnvironment("opencode", source)).not.toHaveProperty(
      "GITHUB_TOKEN",
    );
    expect(providerChildEnvironment("opencode", source)).not.toHaveProperty(
      "DATABASE_URL",
    );
    expect(providerChildEnvironment("opencode", source)).not.toHaveProperty(
      "STRIPE_API_KEY",
    );
    expect(providerChildEnvironment("opencode", source)).not.toHaveProperty(
      "AWS_UNRELATED_SECRET",
    );
    expect(providerChildEnvironment("opencode", source)).not.toHaveProperty(
      "GOOGLE_UNRELATED_TOKEN",
    );
  });

  it("passes cloud credentials to Claude only when its matching route is enabled", () => {
    const source = {
      PATH: process.env.PATH,
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_ACCESS_KEY_ID: "bedrock-id",
      AWS_SECRET_ACCESS_KEY: "bedrock-secret",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/vertex.json",
      GITHUB_TOKEN: "github-secret",
    };

    expect(providerChildEnvironment("claude", source)).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_ACCESS_KEY_ID: "bedrock-id",
      AWS_SECRET_ACCESS_KEY: "bedrock-secret",
    });
    expect(providerChildEnvironment("claude", source)).not.toHaveProperty(
      "GOOGLE_APPLICATION_CREDENTIALS",
    );
    expect(providerChildEnvironment("claude", source)).not.toHaveProperty(
      "GITHUB_TOKEN",
    );

    const vertex = providerChildEnvironment("claude", {
      ...source,
      CLAUDE_CODE_USE_BEDROCK: "0",
      CLAUDE_CODE_USE_VERTEX: "1",
    });
    expect(vertex).toMatchObject({
      CLAUDE_CODE_USE_VERTEX: "1",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/vertex.json",
    });
    expect(vertex).not.toHaveProperty("AWS_ACCESS_KEY_ID");
    expect(vertex).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });
});
