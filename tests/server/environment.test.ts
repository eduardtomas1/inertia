import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  executableCandidates,
  providerChildEnvironment,
  providerEnvironment,
} from "../../src/server/environment";
import { portableNodeExecutable } from "../helpers/portable-provider-fixture";

const ENVIRONMENT_KEYS = [
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
  "LOCALAPPDATA",
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

  it.skipIf(process.platform === "win32")("recovers commands exported by the login shell from a stripped GUI PATH", async () => {
    const home = temporaryRoot();
    const shellBin = join(home, "shell-bin");
    mkdirSync(shellBin, { recursive: true });
    const command = executable(shellBin, "login-shell-agent");
    const shell = join(home, "zsh");
    writeFileSync(
      shell,
      `#!/bin/sh\nPATH=${JSON.stringify(`${shellBin}${delimiter}/usr/bin${delimiter}/bin`)} INERTIA_LOGIN_SHELL_MARKER=ready /usr/bin/env -0\n`,
    );
    chmodSync(shell, 0o700);

    setEnvironment({ HOME: home, SHELL: shell, PATH: "/usr/bin:/bin" });
    const environment = await providerEnvironment(true);
    const candidates = await executableCandidates("login-shell-agent", environment, home);

    expect(environment.env.INERTIA_LOGIN_SHELL_MARKER).toBeUndefined();
    expect(environment.pathEntries[0]).toBe(shellBin);
    expect(candidates).toEqual([realpathSync.native(command)]);
  });

  it.skipIf(process.platform === "win32")(
    "recovers only allowlisted provider, proxy, and CA values from the login shell",
    async () => {
      const home = temporaryRoot();
      const shell = join(home, "zsh");
      const shellValues = {
        PATH: "/usr/bin:/bin",
        HTTPS_PROXY: "http://shell-proxy.test:8443",
        NO_PROXY: "127.0.0.1,localhost",
        NODE_EXTRA_CA_CERTS: join(home, "provider-ca.pem"),
        SSL_CERT_FILE: join(home, "provider-cert.pem"),
        OPENAI_API_KEY: "shell-openai",
        CODEX_HOME: join(home, ".codex-shell"),
        ANTHROPIC_API_KEY: "shell-anthropic",
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_SECRET_ACCESS_KEY: "shell-bedrock",
        CURSOR_API_KEY: "shell-cursor",
        OPENROUTER_API_KEY: "shell-openrouter",
        OPENCODE_CONFIG: join(home, "opencode.json"),
        AWS_ACCESS_KEY_ID: "shell-bedrock-access",
        GOOGLE_APPLICATION_CREDENTIALS: join(
          home,
          "vertex-service-account.json",
        ),
        GOOGLE_CLOUD_PROJECT: "shell-vertex-project",
        VERTEX_LOCATION: "europe-west4",
        GITHUB_TOKEN: "unrelated-github-secret",
        DATABASE_URL: "postgres://unrelated-secret",
        INERTIA_LOGIN_SHELL_MARKER: "unrelated-shell-export",
      };
      const assignments = Object.entries(shellValues)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(" ");
      writeFileSync(shell, `#!/bin/sh\n${assignments} /usr/bin/env -0\n`);
      chmodSync(shell, 0o700);

      setEnvironment({
        HOME: home,
        SHELL: shell,
        PATH: "/usr/bin:/bin",
        HTTPS_PROXY: "http://stale-gui-proxy.test",
        NODE_EXTRA_CA_CERTS: join(home, "stale-gui-ca.pem"),
        OPENAI_API_KEY: "stale-gui-openai",
      });
      const environment = await providerEnvironment(true);

      expect(environment.env).toMatchObject({
        HTTPS_PROXY: shellValues.HTTPS_PROXY,
        NO_PROXY: shellValues.NO_PROXY,
        NODE_EXTRA_CA_CERTS: shellValues.NODE_EXTRA_CA_CERTS,
        SSL_CERT_FILE: shellValues.SSL_CERT_FILE,
        OPENAI_API_KEY: shellValues.OPENAI_API_KEY,
        CODEX_HOME: shellValues.CODEX_HOME,
        ANTHROPIC_API_KEY: shellValues.ANTHROPIC_API_KEY,
        CLAUDE_CODE_USE_BEDROCK: shellValues.CLAUDE_CODE_USE_BEDROCK,
        AWS_SECRET_ACCESS_KEY: shellValues.AWS_SECRET_ACCESS_KEY,
        CURSOR_API_KEY: shellValues.CURSOR_API_KEY,
        OPENROUTER_API_KEY: shellValues.OPENROUTER_API_KEY,
        OPENCODE_CONFIG: shellValues.OPENCODE_CONFIG,
      });
      expect(environment.env).not.toHaveProperty("GITHUB_TOKEN");
      expect(environment.env).not.toHaveProperty("DATABASE_URL");
      expect(environment.env).not.toHaveProperty(
        "INERTIA_LOGIN_SHELL_MARKER",
      );

      const baseline = {
        HTTPS_PROXY: shellValues.HTTPS_PROXY,
        NO_PROXY: shellValues.NO_PROXY,
        NODE_EXTRA_CA_CERTS: shellValues.NODE_EXTRA_CA_CERTS,
        SSL_CERT_FILE: shellValues.SSL_CERT_FILE,
      };
      const cases = [
        {
          providerId: "codex" as const,
          allowed: ["OPENAI_API_KEY", "CODEX_HOME"],
        },
        {
          providerId: "claude" as const,
          allowed: [
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_USE_BEDROCK",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
          ],
        },
        {
          providerId: "cursor" as const,
          allowed: ["CURSOR_API_KEY"],
        },
        {
          providerId: "opencode" as const,
          allowed: [
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "OPENROUTER_API_KEY",
            "OPENCODE_CONFIG",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "GOOGLE_CLOUD_PROJECT",
            "VERTEX_LOCATION",
          ],
        },
      ];
      const providerSentinels = [
        "OPENAI_API_KEY",
        "CODEX_HOME",
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_USE_BEDROCK",
        "AWS_SECRET_ACCESS_KEY",
        "CURSOR_API_KEY",
        "OPENROUTER_API_KEY",
        "OPENCODE_CONFIG",
        "AWS_ACCESS_KEY_ID",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT",
        "VERTEX_LOCATION",
      ];
      for (const { providerId, allowed } of cases) {
        const child = providerChildEnvironment(providerId, environment.env);
        expect(child).toMatchObject(baseline);
        for (const key of providerSentinels) {
          if (allowed.includes(key)) expect(child).toHaveProperty(key);
          else expect(child).not.toHaveProperty(key);
        }
        expect(child).not.toHaveProperty("GITHUB_TOKEN");
        expect(child).not.toHaveProperty("DATABASE_URL");
        expect(child).not.toHaveProperty("INERTIA_LOGIN_SHELL_MARKER");
      }
    },
  );

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
