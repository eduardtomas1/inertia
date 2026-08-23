import { describe, expect, it } from "vitest";

import { runtimeProcessEnvironment } from "../../src/main/runtime-process-environment";

describe("supervised runtime process environment", () => {
  const sentinelSecrets: NodeJS.ProcessEnv = {
    ANTHROPIC_API_KEY: "sentinel-anthropic-secret",
    AWS_SECRET_ACCESS_KEY: "sentinel-aws-secret",
    DYLD_INSERT_LIBRARIES: "/tmp/sentinel-secret.dylib",
    ELECTRON_RUN_AS_NODE: "1",
    GIT_ASKPASS: "/tmp/sentinel-askpass",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: "Authorization: sentinel-secret",
    GIT_EXEC_PATH: "/tmp/sentinel-git-core",
    GITHUB_TOKEN: "sentinel-github-secret",
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
      HOME: "/Users/person",
      LANG: "en_US.UTF-8",
      NODE_ENV: "test",
      NODE_EXTRA_CA_CERTS: "/etc/company/ca.pem",
      PATH: "/opt/bin:/usr/bin:/bin",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      TMPDIR: "/tmp/runtime",
      XDG_CONFIG_HOME: "/Users/person/.config",
      ...sentinelSecrets,
    };

    expect(runtimeProcessEnvironment(parent, "darwin")).toEqual({
      CODEX_HOME: parent.CODEX_HOME,
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
      HOME: parent.HOME,
      LANG: parent.LANG,
      NODE_ENV: parent.NODE_ENV,
      NODE_EXTRA_CA_CERTS: parent.NODE_EXTRA_CA_CERTS,
      PATH: parent.PATH,
      SSH_AUTH_SOCK: parent.SSH_AUTH_SOCK,
      TMPDIR: parent.TMPDIR,
      XDG_CONFIG_HOME: parent.XDG_CONFIG_HOME,
    });
  });

  it("normalizes reviewed Windows keys and omits production bootstrap injection", () => {
    const parent: NodeJS.ProcessEnv = {
      AppData: "C:\\Users\\person\\AppData\\Roaming",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      NODE_ENV: "production",
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
});
