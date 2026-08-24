import { describe, expect, it } from "vitest";

import { runtimeProcessEnvironment } from "../../src/main/runtime-process-environment";
import { PROVIDER_HTTP_ENDPOINT_ROUTING_ENVIRONMENT_KEYS } from "../../src/node/provider-routing-environment";
import { runtimeEnvironmentKind } from "../../src/server/runtime-status";

describe("supervised runtime process environment", () => {
  const sentinelSecrets: NodeJS.ProcessEnv = {
    ANTHROPIC_API_KEY: "sentinel-anthropic-secret",
    ANTHROPIC_CUSTOM_HEADERS: "Authorization: sentinel-secret",
    AWS_ACCESS_KEY_ID: "sentinel-aws-access-key",
    AWS_ENDPOINT_URL_STS:
      "https://sentinel-user:sentinel-secret@sts.example.test",
    AWS_SECRET_ACCESS_KEY: "sentinel-aws-secret",
    AWS_SESSION_TOKEN: "sentinel-aws-session",
    AWS_SHARED_CREDENTIALS_FILE: "/tmp/sentinel-aws-credentials",
    AWS_WEB_IDENTITY_TOKEN_FILE: "/tmp/sentinel-web-identity-token",
    AZURE_OPENAI_API_KEY: "sentinel-azure-openai-secret",
    CLAUDE_CODE_OAUTH_TOKEN: "sentinel-claude-oauth-secret",
    CLOUDFLARE_API_TOKEN: "sentinel-cloudflare-secret",
    CODESPACES_TOKEN: "sentinel-codespaces-token",
    CONTAINER_SECRET: "sentinel-container-secret",
    DYLD_INSERT_LIBRARIES: "/tmp/sentinel-secret.dylib",
    ELECTRON_RUN_AS_NODE: "1",
    GIT_ASKPASS: "/tmp/sentinel-askpass",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: "Authorization: sentinel-secret",
    GIT_EXEC_PATH: "/tmp/sentinel-git-core",
    GITHUB_TOKEN: "sentinel-github-secret",
    GOOGLE_APPLICATION_CREDENTIALS: "/tmp/sentinel-google-credentials.json",
    HOMEBREW_GITHUB_API_TOKEN: "sentinel-homebrew-token",
    HTTPS_PROXY: "https://secret@example.test",
    HTTP_PROXY: "https://secret@example.test",
    INERTIA_CODEX_BACKEND_TOKEN: "sentinel-broker-secret",
    INERTIA_SENTINEL_SECRET: "must-not-cross-runtime-boundary",
    LC_SECRET: "sentinel-locale-secret",
    LD_PRELOAD: "/tmp/sentinel-secret.so",
    LESSOPEN: "|/tmp/sentinel-less-preprocessor",
    NODE_OPTIONS: "--require=/tmp/sentinel-secret.cjs",
    OPENAI_API_KEY: "sentinel-openai-secret",
    PAGER_SECRET: "sentinel-pager-secret",
    SSH_ASKPASS: "/tmp/sentinel-ssh-askpass",
    SSH_PRIVATE_KEY: "sentinel-ssh-private-key",
  };

  it("passes only reviewed POSIX launch values and omits sentinel secrets", () => {
    const parent: NodeJS.ProcessEnv = {
      CODEX_HOME: "/Users/person/.codex",
      ANTHROPIC_BASE_URL: "https://anthropic.example.test",
      AWS_CA_BUNDLE: "/etc/company/aws-ca.pem",
      AWS_ENDPOINT_URL: "https://bedrock.example.test",
      AWS_ENDPOINT_URL_BEDROCK_RUNTIME:
        "https://bedrock-runtime.example.test",
      AWS_PROFILE: "bedrock-profile",
      AWS_REGION: "eu-west-1",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLOUD_ML_REGION: "europe-west4",
      CODESPACE_NAME: "example-space",
      CODESPACES: "true",
      COLORTERM: "truecolor",
      CONTAINER: "podman",
      container: "docker",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/501/bus",
      DESKTOP_SESSION: "gnome-wayland",
      DEVCONTAINER: "true",
      DISPLAY: ":0",
      EDITOR: "/usr/bin/nvim",
      EMAIL: "person@example.test",
      FORCE_COLOR: "3",
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
      LC_ADDRESS: "en_GB.UTF-8",
      LC_IDENTIFICATION: "en_GB.UTF-8",
      LC_MEASUREMENT: "en_GB.UTF-8",
      LC_NAME: "en_GB.UTF-8",
      LC_PAPER: "en_GB.UTF-8",
      LC_TELEPHONE: "en_GB.UTF-8",
      LESS: "-FRX",
      MANPAGER: "/usr/bin/less",
      NODE_ENV: "test",
      NODE_EXTRA_CA_CERTS: "/etc/company/ca.pem",
      NO_COLOR: "1",
      OPENAI_API_VERSION: "2025-04-01-preview",
      OPENAI_BASE_URL: "https://openai.example.test/v1",
      PAGER: "/usr/bin/less",
      PATH: "/opt/bin:/usr/bin:/bin",
      REMOTE_CONTAINERS: "true",
      SSH_AGENT_PID: "4242",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      SSH_CLIENT: "192.0.2.1 12345 22",
      SSH_CONNECTION: "192.0.2.1 12345 192.0.2.2 22",
      SSH_TTY: "/dev/pts/1",
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
      AWS_CA_BUNDLE: parent.AWS_CA_BUNDLE,
      AWS_ENDPOINT_URL: parent.AWS_ENDPOINT_URL,
      AWS_ENDPOINT_URL_BEDROCK_RUNTIME:
        parent.AWS_ENDPOINT_URL_BEDROCK_RUNTIME,
      AWS_PROFILE: parent.AWS_PROFILE,
      AWS_REGION: parent.AWS_REGION,
      CLAUDE_CODE_USE_BEDROCK: parent.CLAUDE_CODE_USE_BEDROCK,
      CLAUDE_CODE_USE_VERTEX: parent.CLAUDE_CODE_USE_VERTEX,
      CLOUD_ML_REGION: parent.CLOUD_ML_REGION,
      CODESPACE_NAME: parent.CODESPACE_NAME,
      CODESPACES: parent.CODESPACES,
      COLORTERM: parent.COLORTERM,
      CONTAINER: parent.CONTAINER,
      container: parent.container,
      DBUS_SESSION_BUS_ADDRESS: parent.DBUS_SESSION_BUS_ADDRESS,
      DESKTOP_SESSION: parent.DESKTOP_SESSION,
      DEVCONTAINER: parent.DEVCONTAINER,
      DISPLAY: parent.DISPLAY,
      EDITOR: parent.EDITOR,
      EMAIL: parent.EMAIL,
      FORCE_COLOR: parent.FORCE_COLOR,
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
      LC_ADDRESS: parent.LC_ADDRESS,
      LC_IDENTIFICATION: parent.LC_IDENTIFICATION,
      LC_MEASUREMENT: parent.LC_MEASUREMENT,
      LC_NAME: parent.LC_NAME,
      LC_PAPER: parent.LC_PAPER,
      LC_TELEPHONE: parent.LC_TELEPHONE,
      LESS: parent.LESS,
      MANPAGER: parent.MANPAGER,
      NODE_ENV: parent.NODE_ENV,
      NODE_EXTRA_CA_CERTS: parent.NODE_EXTRA_CA_CERTS,
      NO_COLOR: parent.NO_COLOR,
      OPENAI_API_VERSION: parent.OPENAI_API_VERSION,
      OPENAI_BASE_URL: parent.OPENAI_BASE_URL,
      PAGER: parent.PAGER,
      PATH: parent.PATH,
      REMOTE_CONTAINERS: parent.REMOTE_CONTAINERS,
      SSH_AGENT_PID: parent.SSH_AGENT_PID,
      SSH_AUTH_SOCK: parent.SSH_AUTH_SOCK,
      SSH_CLIENT: parent.SSH_CLIENT,
      SSH_CONNECTION: parent.SSH_CONNECTION,
      SSH_TTY: parent.SSH_TTY,
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
      Aws_Profile: "windows-bedrock-profile",
      Claude_Code_Use_Bedrock: "1",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      CodeSpace_Name: "windows-space",
      CodeSpaces: "true",
      ColorTerm: "truecolor",
      Container: "windows-container",
      DevContainer: "true",
      Force_Color: "3",
      Gcm_Interactive: "never",
      Git_Config_Global: "C:\\Users\\person\\.gitconfig",
      NODE_ENV: "production",
      INERTIA_STREAMING_TRACE: "1",
      Less: "-FRX",
      ManPager: "C:\\Tools\\less.exe",
      No_Color: "1",
      Pager: "C:\\Tools\\less.exe",
      Path: "C:\\Windows\\System32",
      ProgramData: "C:\\ProgramData",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      ProgramW6432: "C:\\Program Files",
      Remote_Containers: "true",
      Ssh_Client: "192.0.2.1 12345 22",
      Ssh_Connection: "192.0.2.1 12345 192.0.2.2 22",
      Ssh_Tty: "console",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Users\\person\\AppData\\Local\\Temp",
      AllUsersProfile: "C:\\ProgramData",
      Aws_Endpoint_Url_Bedrock_Runtime:
        "https://bedrock-runtime.windows.test",
      UserProfile: "C:\\Users\\person",
      ...sentinelSecrets,
    };

    expect(runtimeProcessEnvironment(parent, "win32")).toEqual({
      APPDATA: parent.AppData,
      AWS_PROFILE: parent.Aws_Profile,
      CLAUDE_CODE_USE_BEDROCK: parent.Claude_Code_Use_Bedrock,
      CODESPACE_NAME: parent.CodeSpace_Name,
      CODESPACES: parent.CodeSpaces,
      COLORTERM: parent.ColorTerm,
      COMSPEC: parent.ComSpec,
      CONTAINER: parent.Container,
      DEVCONTAINER: parent.DevContainer,
      FORCE_COLOR: parent.Force_Color,
      GCM_INTERACTIVE: parent.Gcm_Interactive,
      GIT_CONFIG_GLOBAL: parent.Git_Config_Global,
      LESS: parent.Less,
      MANPAGER: parent.ManPager,
      NO_COLOR: parent.No_Color,
      PAGER: parent.Pager,
      PATH: parent.Path,
      PROGRAMDATA: parent.ProgramData,
      PROGRAMFILES: parent.ProgramFiles,
      "PROGRAMFILES(X86)": parent["ProgramFiles(x86)"],
      PROGRAMW6432: parent.ProgramW6432,
      REMOTE_CONTAINERS: parent.Remote_Containers,
      SSH_CLIENT: parent.Ssh_Client,
      SSH_CONNECTION: parent.Ssh_Connection,
      SSH_TTY: parent.Ssh_Tty,
      SYSTEMROOT: parent.SystemRoot,
      TEMP: parent.TEMP,
      ALLUSERSPROFILE: parent.AllUsersProfile,
      AWS_ENDPOINT_URL_BEDROCK_RUNTIME:
        parent.Aws_Endpoint_Url_Bedrock_Runtime,
      USERPROFILE: parent.UserProfile,
    });
  });

  it.each([
    ["codespaces", { CODESPACES: "true" }],
    ["dev-container", { DEVCONTAINER: "true" }],
    ["ssh", { SSH_CONNECTION: "192.0.2.1 12345 192.0.2.2 22" }],
    ["wsl", { WSL_DISTRO_NAME: "Ubuntu-24.04" }],
    ["container", { container: "podman" }],
  ] as const)("preserves the %s runtime classifier", (expected, source) => {
    expect(runtimeEnvironmentKind(
      runtimeProcessEnvironment(source, "linux"),
    )).toBe(expected);
  });

  it("preserves reviewed Homebrew maintenance paths on macOS", () => {
    expect(runtimeProcessEnvironment({
      HOMEBREW_CACHE: "/Volumes/cache/homebrew",
      HOMEBREW_GITHUB_API_TOKEN: "sentinel-homebrew-token",
      HOMEBREW_PREFIX: "/Volumes/tools/homebrew",
    }, "darwin")).toEqual({
      HOMEBREW_CACHE: "/Volumes/cache/homebrew",
      HOMEBREW_PREFIX: "/Volumes/tools/homebrew",
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

  it.each(["linux", "win32"] as const)(
    "validates every fixed provider endpoint on %s",
    (platform) => {
      for (const key of PROVIDER_HTTP_ENDPOINT_ROUTING_ENVIRONMENT_KEYS) {
        const valid = "https://gateway.example.test/provider/v1/";
        expect(runtimeProcessEnvironment({ [key]: valid }, platform)).toEqual({
          [key]: valid,
        });
        for (const rejected of [
          "https://sentinel-user:sentinel-secret@gateway.example.test/v1",
          "https://gateway.example.test/v1?token=sentinel-secret",
          "https://gateway.example.test/v1#sentinel-secret",
          "https://gateway.example.test/v1/sentinel-secret",
          "https://gateway.example.test/v1/%73ecret-value",
          "https://gateway.example.test/v1\nsentinel",
          `https://gateway.example.test/${"x".repeat(2_048)}`,
        ]) {
          expect(runtimeProcessEnvironment({ [key]: rejected }, platform)).toEqual({});
        }
      }
    },
  );

  it.each(["linux", "win32"] as const)(
    "rejects raw and encoded dot-segment URL normalization bypasses on %s",
    (platform) => {
      for (const value of [
        "http://routing.example.test/..",
        "http://routing.example.test/./",
        "http://routing.example.test/%2e",
        "http://routing.example.test/%2e%2e/",
        "http://routing.example.test/.%2e",
        "http://routing.example.test/%252e%252e/",
      ]) {
        expect(runtimeProcessEnvironment({ HTTP_PROXY: value }, platform)).toEqual({});
        expect(runtimeProcessEnvironment({ AWS_ENDPOINT_URL: value }, platform)).toEqual({});
      }
    },
  );

  it.each(["linux", "win32"] as const)(
    "accepts only bounded documented NO_PROXY entries on %s",
    (platform) => {
      const valid = [
        "localhost",
        ".example.test",
        "*.svc.cluster.local",
        "127.0.0.1",
        "127.0.0.1:8080",
        "10.0.0.0/8",
        "[::1]",
        "[::1]:8443",
        "[2001:db8::]/32",
        "*",
      ].join(",");
      expect(runtimeProcessEnvironment({ NO_PROXY: valid }, platform)).toEqual({
        NO_PROXY: valid,
      });

      for (const rejected of [
        "sentinel-secret@example.test",
        "https://example.test",
        "example.test/private",
        "bad_host.example.test",
        "999.999.999.999",
        "example.test:65536",
        "10.0.0.0/33",
        "[2001:db8::]/129",
        "foo*bar.example.test",
        "localhost,,example.test",
        Array.from({ length: 257 }, () => "localhost").join(","),
      ]) {
        expect(runtimeProcessEnvironment({ NO_PROXY: rejected }, platform)).toEqual({});
      }
    },
  );

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
