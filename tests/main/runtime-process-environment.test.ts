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
      CLAUDE_CODE_USE_VERTEX: "1",
      CLOUD_ML_REGION: "europe-west4",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/501/bus",
      DESKTOP_SESSION: "gnome-wayland",
      DISPLAY: ":0",
      EDITOR: "/usr/bin/nvim",
      EMAIL: "person@example.test",
      GCM_INTERACTIVE: "never",
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
      SSH_AGENT_PID: "4242",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      TMPDIR: "/tmp/runtime",
      VERTEX_LOCATION: "europe-west4",
      VISUAL: "/usr/bin/nvim",
      WAYLAND_DISPLAY: "wayland-0",
      WSL_DISTRO_NAME: "Ubuntu-24.04",
      WSL_INTEROP: "/run/WSL/1234_interop",
      WSLENV: "USERPROFILE/up:PROGRAMDATA/up",
      XAUTHORITY: "/run/user/501/gdm/Xauthority",
      XDG_CONFIG_HOME: "/Users/person/.config",
      XDG_CURRENT_DESKTOP: "GNOME",
      XDG_SESSION_DESKTOP: "gnome",
      XDG_SESSION_TYPE: "wayland",
      XDG_STATE_HOME: "/Users/person/.local/state-work",
      ZDOTDIR: "/Users/person/.config/zsh-work",
      ...sentinelSecrets,
    };

    expect(runtimeProcessEnvironment(parent, "linux")).toEqual({
      CODEX_HOME: parent.CODEX_HOME,
      ANTHROPIC_BASE_URL: parent.ANTHROPIC_BASE_URL,
      AWS_PROFILE: parent.AWS_PROFILE,
      AWS_REGION: parent.AWS_REGION,
      CLAUDE_CODE_USE_BEDROCK: parent.CLAUDE_CODE_USE_BEDROCK,
      CLAUDE_CODE_USE_VERTEX: parent.CLAUDE_CODE_USE_VERTEX,
      CLOUD_ML_REGION: parent.CLOUD_ML_REGION,
      DBUS_SESSION_BUS_ADDRESS: parent.DBUS_SESSION_BUS_ADDRESS,
      DESKTOP_SESSION: parent.DESKTOP_SESSION,
      DISPLAY: parent.DISPLAY,
      EDITOR: parent.EDITOR,
      EMAIL: parent.EMAIL,
      GCM_INTERACTIVE: parent.GCM_INTERACTIVE,
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
      SSH_AGENT_PID: parent.SSH_AGENT_PID,
      SSH_AUTH_SOCK: parent.SSH_AUTH_SOCK,
      TMPDIR: parent.TMPDIR,
      VERTEX_LOCATION: parent.VERTEX_LOCATION,
      VISUAL: parent.VISUAL,
      WAYLAND_DISPLAY: parent.WAYLAND_DISPLAY,
      WSL_DISTRO_NAME: parent.WSL_DISTRO_NAME,
      WSL_INTEROP: parent.WSL_INTEROP,
      WSLENV: parent.WSLENV,
      XAUTHORITY: parent.XAUTHORITY,
      XDG_CONFIG_HOME: parent.XDG_CONFIG_HOME,
      XDG_CURRENT_DESKTOP: parent.XDG_CURRENT_DESKTOP,
      XDG_SESSION_DESKTOP: parent.XDG_SESSION_DESKTOP,
      XDG_SESSION_TYPE: parent.XDG_SESSION_TYPE,
      XDG_STATE_HOME: parent.XDG_STATE_HOME,
      ZDOTDIR: parent.ZDOTDIR,
    });
  });

  it("normalizes reviewed Windows keys and omits production bootstrap injection", () => {
    const parent: NodeJS.ProcessEnv = {
      AppData: "C:\\Users\\person\\AppData\\Roaming",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      NODE_ENV: "production",
      INERTIA_STREAMING_TRACE: "1",
      Path: "C:\\Windows\\System32",
      ProgramData: "C:\\ProgramData",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      ProgramW6432: "C:\\Program Files",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Users\\person\\AppData\\Local\\Temp",
      AllUsersProfile: "C:\\ProgramData",
      UserProfile: "C:\\Users\\person",
      ...sentinelSecrets,
    };

    expect(runtimeProcessEnvironment(parent, "win32")).toEqual({
      APPDATA: parent.AppData,
      COMSPEC: parent.ComSpec,
      PATH: parent.Path,
      PROGRAMDATA: parent.ProgramData,
      PROGRAMFILES: parent.ProgramFiles,
      "PROGRAMFILES(X86)": parent["ProgramFiles(x86)"],
      PROGRAMW6432: parent.ProgramW6432,
      SYSTEMROOT: parent.SystemRoot,
      TEMP: parent.TEMP,
      ALLUSERSPROFILE: parent.AllUsersProfile,
      USERPROFILE: parent.UserProfile,
    });
  });

  it("passes credential-free proxy routing and rejects credential-bearing values", () => {
    const parent: NodeJS.ProcessEnv = {
      ALL_PROXY: "socks5://socks.example.test:1080",
      HTTP_PROXY: "http://proxy.example.test:8080",
      HTTPS_PROXY: "https://sentinel-user:sentinel-secret@proxy.example.test:8443",
      NO_PROXY: "localhost,.example.test,127.0.0.1",
      all_proxy: "socks5://sentinel-user:sentinel-secret@socks.example.test:1080",
      http_proxy: "http://sentinel-user:sentinel-secret@proxy.example.test:8080",
      https_proxy: "https://proxy.example.test:8443",
      no_proxy: "localhost,[::1]",
    };

    expect(runtimeProcessEnvironment(parent, "linux")).toEqual({
      ALL_PROXY: parent.ALL_PROXY,
      HTTP_PROXY: parent.HTTP_PROXY,
      NO_PROXY: parent.NO_PROXY,
      https_proxy: parent.https_proxy,
      no_proxy: parent.no_proxy,
    });
    expect(runtimeProcessEnvironment({
      http_proxy: "http://proxy.windows.test:8080",
    }, "win32")).toEqual({
      HTTP_PROXY: "http://proxy.windows.test:8080",
    });
    for (const value of [
      "http://sentinel-user:sentinel-secret@proxy.example.test:8080",
      "http://proxy.example.test:8080/sentinel-secret",
      "http://proxy.example.test:8080?token=sentinel-secret",
      "http://proxy.example.test:8080#sentinel-secret",
      "file:///tmp/sentinel-proxy",
      "not a proxy URL",
      `http://proxy.example.test/${"x".repeat(2_048)}`,
    ]) {
      expect(runtimeProcessEnvironment({ HTTP_PROXY: value }, "linux")).toEqual({});
    }
    expect(runtimeProcessEnvironment({
      NO_PROXY: "sentinel-secret@example.test",
    }, "linux")).toEqual({});
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
