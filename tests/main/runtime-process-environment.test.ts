import { describe, expect, it } from "vitest";

import { runtimeProcessEnvironment } from "../../src/main/runtime-process-environment";

describe("supervised runtime process environment", () => {
  const sentinelSecrets: NodeJS.ProcessEnv = {
    ANTHROPIC_API_KEY: "sentinel-anthropic-secret",
    ANTHROPIC_CUSTOM_HEADERS: "Authorization: sentinel-secret",
    AWS_ACCESS_KEY_ID: "sentinel-aws-access-key",
    AWS_SECRET_ACCESS_KEY: "sentinel-aws-secret",
    AWS_SESSION_TOKEN: "sentinel-aws-session",
    AWS_SHARED_CREDENTIALS_FILE: "/tmp/sentinel-aws-credentials",
    AWS_WEB_IDENTITY_TOKEN_FILE: "/tmp/sentinel-web-identity-token",
    AZURE_OPENAI_API_KEY: "sentinel-azure-openai-secret",
    CLAUDE_CODE_OAUTH_TOKEN: "sentinel-claude-oauth-secret",
    CLOUDFLARE_API_TOKEN: "sentinel-cloudflare-secret",
    DYLD_INSERT_LIBRARIES: "/tmp/sentinel-secret.dylib",
    ELECTRON_RUN_AS_NODE: "1",
    GIT_ASKPASS: "/tmp/sentinel-askpass",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: "Authorization: sentinel-secret",
    GIT_EXEC_PATH: "/tmp/sentinel-git-core",
    GITHUB_TOKEN: "sentinel-github-secret",
    GOOGLE_APPLICATION_CREDENTIALS: "/tmp/sentinel-google-credentials.json",
    HTTPS_PROXY: "https://secret@example.test",
    HTTP_PROXY: "https://secret@example.test",
    INERTIA_CODEX_BACKEND_TOKEN: "sentinel-broker-secret",
    INERTIA_SENTINEL_SECRET: "must-not-cross-runtime-boundary",
    LC_SECRET: "sentinel-locale-secret",
    LD_PRELOAD: "/tmp/sentinel-secret.so",
    NODE_OPTIONS: "--require=/tmp/sentinel-secret.cjs",
    OPENAI_API_KEY: "sentinel-openai-secret",
    SSH_ASKPASS: "/tmp/sentinel-ssh-askpass",
  };

  it("passes only reviewed POSIX launch values and omits sentinel secrets", () => {
    const parent: NodeJS.ProcessEnv = {
      CODEX_HOME: "/Users/person/.codex",
      ANTHROPIC_BASE_URL: "https://anthropic.example.test",
      AWS_PROFILE: "bedrock-profile",
      AWS_REGION: "eu-west-1",
      CLAUDE_CODE_USE_BEDROCK: "1",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/501/bus",
      DISPLAY: ":0",
      EMAIL: "person@example.test",
      GIT_AUTHOR_EMAIL: "author@example.test",
      GIT_AUTHOR_NAME: "Example Author",
      GIT_CEILING_DIRECTORIES: "/Users/person/work",
      GIT_COMMITTER_EMAIL: "committer@example.test",
      GIT_COMMITTER_NAME: "Example Committer",
      GIT_CONFIG_GLOBAL: "/Users/person/.config/git/config",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/etc/company/gitconfig",
      GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
      GIT_SSH: "/usr/bin/ssh",
      GIT_SSH_COMMAND: "/usr/bin/ssh -F /Users/person/.ssh/config",
      GIT_SSH_VARIANT: "ssh",
      GNUPGHOME: "/Users/person/.gnupg-work",
      GOOGLE_CLOUD_PROJECT: "vertex-project",
      GPG_TTY: "/dev/ttys001",
      HOME: "/Users/person",
      INERTIA_STREAMING_TRACE: "1",
      LANG: "en_US.UTF-8",
      NODE_ENV: "test",
      NODE_EXTRA_CA_CERTS: "/etc/company/ca.pem",
      OPENAI_API_VERSION: "2025-04-01-preview",
      OPENAI_BASE_URL: "https://openai.example.test/v1",
      PATH: "/opt/bin:/usr/bin:/bin",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      TMPDIR: "/tmp/runtime",
      VERTEX_LOCATION: "europe-west4",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_CONFIG_HOME: "/Users/person/.config",
      ...sentinelSecrets,
    };

    expect(runtimeProcessEnvironment(parent, "linux")).toEqual({
      CODEX_HOME: parent.CODEX_HOME,
      ANTHROPIC_BASE_URL: parent.ANTHROPIC_BASE_URL,
      AWS_PROFILE: parent.AWS_PROFILE,
      AWS_REGION: parent.AWS_REGION,
      CLAUDE_CODE_USE_BEDROCK: parent.CLAUDE_CODE_USE_BEDROCK,
      DBUS_SESSION_BUS_ADDRESS: parent.DBUS_SESSION_BUS_ADDRESS,
      DISPLAY: parent.DISPLAY,
      EMAIL: parent.EMAIL,
      GIT_AUTHOR_EMAIL: parent.GIT_AUTHOR_EMAIL,
      GIT_AUTHOR_NAME: parent.GIT_AUTHOR_NAME,
      GIT_CEILING_DIRECTORIES: parent.GIT_CEILING_DIRECTORIES,
      GIT_COMMITTER_EMAIL: parent.GIT_COMMITTER_EMAIL,
      GIT_COMMITTER_NAME: parent.GIT_COMMITTER_NAME,
      GIT_CONFIG_GLOBAL: parent.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_NOSYSTEM: parent.GIT_CONFIG_NOSYSTEM,
      GIT_CONFIG_SYSTEM: parent.GIT_CONFIG_SYSTEM,
      GIT_DISCOVERY_ACROSS_FILESYSTEM: parent.GIT_DISCOVERY_ACROSS_FILESYSTEM,
      GIT_SSH: parent.GIT_SSH,
      GIT_SSH_COMMAND: parent.GIT_SSH_COMMAND,
      GIT_SSH_VARIANT: parent.GIT_SSH_VARIANT,
      GNUPGHOME: parent.GNUPGHOME,
      GOOGLE_CLOUD_PROJECT: parent.GOOGLE_CLOUD_PROJECT,
      GPG_TTY: parent.GPG_TTY,
      HOME: parent.HOME,
      INERTIA_STREAMING_TRACE: parent.INERTIA_STREAMING_TRACE,
      LANG: parent.LANG,
      NODE_ENV: parent.NODE_ENV,
      NODE_EXTRA_CA_CERTS: parent.NODE_EXTRA_CA_CERTS,
      OPENAI_API_VERSION: parent.OPENAI_API_VERSION,
      OPENAI_BASE_URL: parent.OPENAI_BASE_URL,
      PATH: parent.PATH,
      SSH_AUTH_SOCK: parent.SSH_AUTH_SOCK,
      TMPDIR: parent.TMPDIR,
      VERTEX_LOCATION: parent.VERTEX_LOCATION,
      WAYLAND_DISPLAY: parent.WAYLAND_DISPLAY,
      XDG_CONFIG_HOME: parent.XDG_CONFIG_HOME,
    });
  });

  it("normalizes reviewed Windows keys and omits production bootstrap injection", () => {
    const parent: NodeJS.ProcessEnv = {
      AppData: "C:\\Users\\person\\AppData\\Roaming",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      NODE_ENV: "production",
      INERTIA_STREAMING_TRACE: "1",
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Users\\person\\AppData\\Local\\Temp",
      UserProfile: "C:\\Users\\person",
      ...sentinelSecrets,
    };

    expect(runtimeProcessEnvironment(parent, "win32")).toEqual({
      APPDATA: parent.AppData,
      COMSPEC: parent.ComSpec,
      PATH: parent.Path,
      SYSTEMROOT: parent.SystemRoot,
      TEMP: parent.TEMP,
      USERPROFILE: parent.UserProfile,
    });
  });

  it("requires the exact test-only streaming trace opt-in", () => {
    expect(runtimeProcessEnvironment({
      INERTIA_STREAMING_TRACE: "1",
      NODE_ENV: "production",
    }, "linux")).toEqual({});
    expect(runtimeProcessEnvironment({
      INERTIA_STREAMING_TRACE: "true",
      NODE_ENV: "test",
    }, "linux")).toEqual({ NODE_ENV: "test" });
  });
});
