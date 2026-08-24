import { isIP } from "node:net";
import { GIT_LAUNCH_ENVIRONMENT_KEYS } from "../node/git-environment";
import {
  isCredentialFreeProviderHttpEndpoint,
  isClaudeCloudRoutingEnvironmentKey,
  isValidClaudeCloudRoutingEnvironmentValue,
  PROVIDER_ENDPOINT_ROUTING_ENVIRONMENT_KEY,
  PROVIDER_HTTP_ENDPOINT_ROUTING_ENVIRONMENT_KEYS,
  PROVIDER_ROUTING_ENVIRONMENT_KEYS,
} from "../node/provider-routing-environment";

const RUNTIME_PROCESS_ENVIRONMENT_KEYS = [
  "ALLUSERSPROFILE",
  "APPDATA",
  "BUN_INSTALL",
  "CODESPACE_NAME",
  "CODESPACES",
  "CODEX_HOME",
  "CODEX_INSTALL_DIR",
  "COLORTERM",
  "COMSPEC",
  "CONTAINER",
  "CURSOR_HOME",
  "DBUS_SESSION_BUS_ADDRESS",
  "DESKTOP_SESSION",
  "DEVCONTAINER",
  "DISPLAY",
  "EDITOR",
  "FORCE_COLOR",
  "GH_CONFIG_DIR",
  "HOME",
  "HOMEBREW_CACHE",
  "HOMEBREW_PREFIX",
  "HOMEDRIVE",
  "HOMEPATH",
  "KUBECONFIG",
  "LANG",
  "LANGUAGE",
  "LC_ADDRESS",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_IDENTIFICATION",
  "LC_MEASUREMENT",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NAME",
  "LC_NUMERIC",
  "LC_PAPER",
  "LC_TELEPHONE",
  "LC_TIME",
  "LESS",
  "LOCALAPPDATA",
  "LOGNAME",
  "MANPAGER",
  "NODE_ENV",
  "NODE_EXTRA_CA_CERTS",
  "NVM_BIN",
  "NO_COLOR",
  "PAGER",
  "PATH",
  "PATHEXT",
  "PNPM_HOME",
  "OPENCODE_CONFIG",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "REMOTE_CONTAINERS",
  "SHELL",
  "SSH_AUTH_SOCK",
  "SSH_CLIENT",
  "SSH_CONNECTION",
  "SSH_TTY",
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
  "VISUAL",
  "VOLTA_HOME",
  "WAYLAND_DISPLAY",
  "WINDIR",
  "WSL_DISTRO_NAME",
  "WSL_INTEROP",
  "WSLENV",
  "XAUTHORITY",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CONFIG_DIRS",
  "XDG_CURRENT_DESKTOP",
  "XDG_DATA_HOME",
  "XDG_DATA_DIRS",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_TYPE",
  "XDG_STATE_HOME",
  "ZDOTDIR",
  ...GIT_LAUNCH_ENVIRONMENT_KEYS,
  ...PROVIDER_ROUTING_ENVIRONMENT_KEYS,
] as const;

const RUNTIME_POSIX_CASE_SENSITIVE_ENVIRONMENT_KEYS = ["container"] as const;

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

const HTTP_ENDPOINT_PROTOCOLS = new Set(["http:", "https:"]);

const PROVIDER_HTTP_ENDPOINT_ROUTING_ENVIRONMENT_KEY_SET = new Set<string>(
  PROVIDER_HTTP_ENDPOINT_ROUTING_ENVIRONMENT_KEYS,
);

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const URL_DOT_SEGMENT = /(?:^|[\\/])\.{1,2}(?=[\\/?#]|$)/u;
const MAXIMUM_URL_DECODE_PASSES = 4;
const MAXIMUM_NO_PROXY_ENTRIES = 256;
const MAXIMUM_NO_PROXY_ENTRY_LENGTH = 512;

function decodedUrlRepresentations(value: string): string[] | null {
  const representations = [value];
  let current = value;
  for (let pass = 0; pass < MAXIMUM_URL_DECODE_PASSES; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (decoded === current) return representations;
    representations.push(decoded);
    current = decoded;
  }
  try {
    return decodeURIComponent(current) === current ? representations : null;
  } catch {
    return null;
  }
}

function credentialFreeUrl(
  value: string,
  protocols: ReadonlySet<string>,
): URL | null {
  if (value.length === 0 || value.length > 2_048) return null;
  const representations = decodedUrlRepresentations(value);
  if (
    representations === null
    || representations.some((candidate) =>
      CONTROL_CHARACTER.test(candidate) || URL_DOT_SEGMENT.test(candidate))
  ) return null;
  try {
    const parsed = new URL(value);
    return protocols.has(parsed.protocol)
      && parsed.hostname.length > 0
      && parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.search.length === 0
      && parsed.hash.length === 0
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function credentialFreeProxyUrl(value: string): boolean {
  const parsed = credentialFreeUrl(value, PROXY_PROTOCOLS);
  return parsed !== null && (parsed.pathname === "" || parsed.pathname === "/");
}

function credentialFreeHttpEndpoint(value: string): boolean {
  const parsed = credentialFreeUrl(value, HTTP_ENDPOINT_PROTOCOLS);
  return parsed !== null && (parsed.pathname === "" || parsed.pathname === "/");
}

function validPort(value: string | undefined): boolean {
  if (value === undefined) return true;
  if (!/^\d{1,5}$/u.test(value)) return false;
  const port = Number(value);
  return port >= 1 && port <= 65_535;
}

function validHostname(value: string): boolean {
  const hostname = value.endsWith(".") ? value.slice(0, -1) : value;
  return hostname.length > 0
    && hostname.length <= 253
    && hostname.split(".").every((label) =>
      label.length > 0
      && label.length <= 63
      && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label));
}

function validNoProxyCidr(value: string): boolean {
  const match = /^(\[[^\]]+\]|[^/]+)\/(\d{1,3})$/u.exec(value);
  if (!match) return false;
  const address = match[1]!.startsWith("[")
    ? match[1]!.slice(1, -1)
    : match[1]!;
  const version = isIP(address);
  const prefix = Number(match[2]);
  return (version === 4 && prefix <= 32) || (version === 6 && prefix <= 128);
}

function validNoProxyHost(value: string): boolean {
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/u.exec(value);
  if (bracketed) return isIP(bracketed[1]!) === 6 && validPort(bracketed[2]);
  if (isIP(value) === 6) return true;

  const hostAndPort = /^([^:]+?)(?::(\d{1,5}))?$/u.exec(value);
  if (!hostAndPort || !validPort(hostAndPort[2])) return false;
  const host = hostAndPort[1]!;
  if (isIP(host) === 4) return true;
  if (/^\d+(?:\.\d+){3}$/u.test(host)) return false;
  const hostname = host.startsWith("*.")
    ? host.slice(2)
    : host.startsWith(".")
      ? host.slice(1)
      : host;
  return validHostname(hostname)
    && (host === hostname || host.startsWith(".") || host.startsWith("*."));
}

function validNoProxyEntry(value: string): boolean {
  if (value === "*") return true;
  return value.includes("/") ? validNoProxyCidr(value) : validNoProxyHost(value);
}

function credentialFreeNoProxy(value: string): boolean {
  if (value.length === 0 || value.length > 8_192 || CONTROL_CHARACTER.test(value)) {
    return false;
  }
  // A bounded comma-separated list of DNS names (optionally prefixed by `.`
  // or `*.`), IPv4/IPv6 literals, IP CIDRs, optional host ports, or exact `*`.
  // CIDRs cannot carry ports; IPv6 ports require brackets.
  const entries = value.split(",").map((entry) => entry.trim());
  return entries.length <= MAXIMUM_NO_PROXY_ENTRIES
    && entries.every((entry) =>
      entry.length > 0
      && entry.length <= MAXIMUM_NO_PROXY_ENTRY_LENGTH
      && validNoProxyEntry(entry));
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
    if (
      value === undefined
      || (key === "NODE_ENV" && value !== "test")
      || (
        PROVIDER_HTTP_ENDPOINT_ROUTING_ENVIRONMENT_KEY_SET.has(key)
        && !isCredentialFreeProviderHttpEndpoint(value)
      )
      || (
        isClaudeCloudRoutingEnvironmentKey(key)
        && !isValidClaudeCloudRoutingEnvironmentValue(key, value)
      )
    ) {
      continue;
    }
    sanitized[key] = value;
  }
  if (platform !== "win32") {
    for (const key of RUNTIME_POSIX_CASE_SENSITIVE_ENVIRONMENT_KEYS) {
      const value = environment[key];
      if (value !== undefined) sanitized[key] = value;
    }
  }
  for (const [key, value] of Object.entries(environment)) {
    const normalized = key.toUpperCase();
    if (
      value !== undefined
      && (platform === "win32" || key === normalized)
      && PROVIDER_ENDPOINT_ROUTING_ENVIRONMENT_KEY.test(normalized)
      && credentialFreeHttpEndpoint(value)
    ) {
      sanitized[normalized] = value;
    }
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
