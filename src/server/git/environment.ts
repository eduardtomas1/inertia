const PASSTHROUGH_ENVIRONMENT_KEYS = new Set([
  "ALL_PROXY",
  "APPDATA",
  "COMSPEC",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "GCM_INTERACTIVE",
  "GNUPGHOME",
  "GPG_TTY",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LOCALAPPDATA",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SSH_AGENT_PID",
  "SSH_AUTH_SOCK",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "WAYLAND_DISPLAY",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
]);

const PASSTHROUGH_GIT_ENVIRONMENT_KEYS = new Set([
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_SYSTEM",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_SSH_VARIANT",
]);

const TRUSTED_GIT_OVERRIDE_KEYS = new Set([
  ...PASSTHROUGH_GIT_ENVIRONMENT_KEYS,
  "GIT_ATTR_NOSYSTEM",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE",
]);

export function gitProcessEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    const normalized = key.toUpperCase();
    if (
      PASSTHROUGH_ENVIRONMENT_KEYS.has(normalized)
      || PASSTHROUGH_GIT_ENVIRONMENT_KEYS.has(normalized)
    ) sanitized[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (
      value !== undefined
      && (
        PASSTHROUGH_ENVIRONMENT_KEYS.has(key.toUpperCase())
        || TRUSTED_GIT_OVERRIDE_KEYS.has(key.toUpperCase())
      )
    ) sanitized[key] = value;
  }
  return {
    ...sanitized,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    LANG: "C",
    LC_ALL: "C",
  };
}
