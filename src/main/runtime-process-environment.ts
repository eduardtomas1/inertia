import { GIT_LAUNCH_ENVIRONMENT_KEYS } from "../node/git-environment";
import { PROVIDER_ROUTING_ENVIRONMENT_KEYS } from "../node/provider-routing-environment";

const RUNTIME_PROCESS_ENVIRONMENT_KEYS = [
  "ALLUSERSPROFILE",
  "APPDATA",
  "BUN_INSTALL",
  "CODEX_HOME",
  "CODEX_INSTALL_DIR",
  "COMSPEC",
  "CURSOR_HOME",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "GH_CONFIG_DIR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "LOCALAPPDATA",
  "LOGNAME",
  "NODE_ENV",
  "NODE_EXTRA_CA_CERTS",
  "NVM_BIN",
  "PATH",
  "PATHEXT",
  "PNPM_HOME",
  "OPENCODE_CONFIG",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "SHELL",
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
  "VOLTA_HOME",
  "WAYLAND_DISPLAY",
  "WINDIR",
  "XAUTHORITY",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
  "ZDOTDIR",
  ...GIT_LAUNCH_ENVIRONMENT_KEYS,
  ...PROVIDER_ROUTING_ENVIRONMENT_KEYS,
] as const;

function environmentValue(
  environment: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return environment[key];
  const normalized = key.toUpperCase();
  const match = Object.keys(environment).find(
    (candidate) => candidate.toUpperCase() === normalized,
  );
  return match ? environment[match] : undefined;
}

/**
 * The supervised runtime receives only process-launch essentials and reviewed
 * filesystem locations. Provider credentials remain behind the privileged
 * broker instead of crossing the Electron utility-process boundary.
 */
export function runtimeProcessEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const key of RUNTIME_PROCESS_ENVIRONMENT_KEYS) {
    const value = environmentValue(environment, key, platform);
    if (value === undefined || (key === "NODE_ENV" && value !== "test")) {
      continue;
    }
    sanitized[key] = value;
  }
  if (
    sanitized.NODE_ENV === "test"
    && environmentValue(environment, "INERTIA_STREAMING_TRACE", platform) === "1"
  ) {
    sanitized.INERTIA_STREAMING_TRACE = "1";
  }
  return sanitized;
}
