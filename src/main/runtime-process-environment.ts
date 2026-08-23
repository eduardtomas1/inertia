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

const RUNTIME_PROXY_ENVIRONMENT_KEYS = [
  "ALL_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
] as const;

const PROXY_PROTOCOLS = new Set([
  "http:",
  "https:",
  "socks:",
  "socks4:",
  "socks4a:",
  "socks5:",
  "socks5h:",
]);

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function credentialFreeProxyUrl(value: string): boolean {
  if (value.length === 0 || value.length > 2_048 || CONTROL_CHARACTER.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return PROXY_PROTOCOLS.has(parsed.protocol)
      && parsed.hostname.length > 0
      && parsed.username.length === 0
      && parsed.password.length === 0
      && (parsed.pathname === "" || parsed.pathname === "/")
      && parsed.search.length === 0
      && parsed.hash.length === 0;
  } catch {
    return false;
  }
}

function credentialFreeNoProxy(value: string): boolean {
  return value.length <= 8_192
    && !CONTROL_CHARACTER.test(value)
    && !value.includes("@");
}

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
  for (const key of RUNTIME_PROXY_ENVIRONMENT_KEYS) {
    const variants = platform === "win32" ? [key] : [key, key.toLowerCase()];
    for (const variant of variants) {
      const value = environmentValue(environment, variant, platform);
      if (value !== undefined && credentialFreeProxyUrl(value)) {
        sanitized[variant] = value;
      }
    }
  }
  for (const key of platform === "win32" ? ["NO_PROXY"] : ["NO_PROXY", "no_proxy"]) {
    const value = environmentValue(environment, key, platform);
    if (value !== undefined && credentialFreeNoProxy(value)) {
      sanitized[key] = value;
    }
  }
  if (
    sanitized.NODE_ENV === "test"
    && environmentValue(environment, "INERTIA_STREAMING_TRACE", platform) === "1"
  ) {
    sanitized.INERTIA_STREAMING_TRACE = "1";
  }
  return sanitized;
}
