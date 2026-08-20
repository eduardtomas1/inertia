import { constants as fsConstants } from "node:fs";
import { access, open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { ProviderId } from "./provider/contracts";

export interface ProviderEnvironment {
  env: NodeJS.ProcessEnv;
  pathEntries: string[];
}

/**
 * Expand the leading home-directory shorthand that a shell normally resolves.
 * Child processes are launched with shell:false, so CODEX_HOME=~/.codex-work
 * would otherwise reach Codex as a literal relative path.
 */
export function expandHomePath(value: string): string {
  if (!value) return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function normalizeCodexHomeEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const codexHomeKey = Object.keys(environment).find(
    (key) => key.toUpperCase() === "CODEX_HOME",
  );
  if (!codexHomeKey) return environment;
  const value = environment[codexHomeKey];
  if (value !== undefined) environment[codexHomeKey] = expandHomePath(value);
  return environment;
}

let environmentPromise: Promise<ProviderEnvironment> | undefined;

const SAFE_CHILD_ENVIRONMENT_KEYS = new Set([
  "ALL_PROXY",
  "APPDATA",
  "COLORTERM",
  "COMSPEC",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LOCALAPPDATA",
  "LOGNAME",
  "NO_COLOR",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "PATHEXT",
  "SHELL",
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
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);

const PROVIDER_ENVIRONMENT_KEYS: Record<ProviderId, readonly RegExp[]> = {
  codex: [
    /^(?:AZURE_)?OPENAI_(?:API_KEY|BASE_URL|ENDPOINT|API_VERSION)$/u,
    /^CODEX_(?:API_KEY|HOME|INSTALL_DIR)$/u,
  ],
  claude: [
    /^ANTHROPIC_[A-Z0-9_]+$/u,
    /^CLAUDE_CODE_[A-Z0-9_]+$/u,
    /^DISABLE_(?:AUTOUPDATER|BUG_COMMAND|ERROR_REPORTING|PROMPT_CACHING|TELEMETRY)$/u,
  ],
  cursor: [
    /^CURSOR_(?:API_KEY|HOME)$/u,
  ],
  kimi: [
    /^GOOGLE_APPLICATION_CREDENTIALS$/u,
    /^KIMI_[A-Z0-9_]+$/u,
  ],
  opencode: [
    /^(?:ANTHROPIC|CEREBRAS|COHERE|DEEPSEEK|FIREWORKS|GEMINI|GROQ|MISTRAL|OPENAI|OPENROUTER|PERPLEXITY|TOGETHER|XAI)_API_KEY$/u,
    /^(?:AZURE_OPENAI|GOOGLE_GENERATIVE_AI)_[A-Z0-9_]+$/u,
    /^(?:AICORE_DEPLOYMENT_ID|AICORE_RESOURCE_GROUP|AICORE_SERVICE_KEY|AI_API_URL)$/u,
    /^(?:AWS_ACCESS_KEY_ID|AWS_BEARER_TOKEN_BEDROCK|AWS_CONFIG_FILE|AWS_DEFAULT_REGION|AWS_PROFILE|AWS_REGION|AWS_ROLE_ARN|AWS_ROLE_SESSION_NAME|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_SHARED_CREDENTIALS_FILE|AWS_WEB_IDENTITY_TOKEN_FILE)$/u,
    /^(?:AZURE_COGNITIVE_SERVICES_RESOURCE_NAME|AZURE_RESOURCE_NAME)$/u,
    /^(?:CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_KEY|CLOUDFLARE_API_TOKEN|CLOUDFLARE_GATEWAY_ID)$/u,
    /^(?:DIGITALOCEAN_ACCESS_TOKEN|GITLAB_AI_GATEWAY_URL|GITLAB_INSTANCE_URL|GITLAB_OAUTH_CLIENT_ID|GITLAB_TOKEN)$/u,
    /^(?:GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|VERTEX_LOCATION)$/u,
    /^(?:NVIDIA_API_KEY|SNOWFLAKE_ACCOUNT|SNOWFLAKE_CORTEX_PAT|SNOWFLAKE_CORTEX_TOKEN)$/u,
    /^OPENCODE_[A-Z0-9_]+$/u,
  ],
};

export function providerChildEnvironment(
  providerId: ProviderId,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const normalized = key.toUpperCase();
    if (
      SAFE_CHILD_ENVIRONMENT_KEYS.has(normalized)
      || normalized.startsWith("LC_")
      || PROVIDER_ENVIRONMENT_KEYS[providerId].some((pattern) =>
        pattern.test(normalized))
    ) {
      result[key] = value;
    }
  }
  if (providerId === "codex") normalizeCodexHomeEnvironment(result);
  if (
    providerId === "claude"
    && source.CLAUDE_CODE_USE_BEDROCK === "1"
  ) {
    copyMatchingEnvironment(
      result,
      source,
      /^(?:AWS|AMAZON)_[A-Z0-9_]+$/u,
    );
  }
  if (
    providerId === "claude"
    && source.CLAUDE_CODE_USE_VERTEX === "1"
  ) {
    copyMatchingEnvironment(
      result,
      source,
      /^(?:CLOUD_ML|GOOGLE|GCLOUD)_[A-Z0-9_]+$/u,
    );
  }
  return result;
}

/**
 * Environment for installation/readiness probes that must not receive provider
 * credentials. Only the executable path, process-launch essentials, locale,
 * and temporary-directory settings are retained. Home/config paths, proxies,
 * certificates, and provider-specific authentication variables are omitted.
 */
export function credentialFreeProviderEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const safeKeys = new Set([
    "COMSPEC",
    "LANG",
    "PATH",
    "PATHEXT",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "TZ",
    "WINDIR",
  ]);
  const result: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const normalized = key.toUpperCase();
    if (
      safeKeys.has(normalized)
      || normalized.startsWith("LC_")
    ) result[key] = value;
  }
  return result;
}

function copyMatchingEnvironment(
  target: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv,
  pattern: RegExp,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && pattern.test(key.toUpperCase())) {
      target[key] = value;
    }
  }
}

function unique(values: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (!value) return false;
    const key = platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function environmentValue(
  environment: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "win32") return environment[key];
  const normalized = key.toUpperCase();
  const match = Object.keys(environment).find((candidate) => candidate.toUpperCase() === normalized);
  return match ? environment[match] : undefined;
}

export async function loginShellEnvironment(): Promise<NodeJS.ProcessEnv> {
  // Login shells execute arbitrary user dotfiles, which may leave process
  // trees outside the runtime's cleanup authority. Provider discovery uses
  // the inherited environment plus bounded, reviewed CLI locations instead.
  return {};
}

async function boundedNvmDefaultVersion(home: string): Promise<readonly bigint[] | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const flags = fsConstants.O_RDONLY | (process.platform === "win32"
      ? 0
      : fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
    handle = await open(join(home, ".nvm", "alias", "default"), flags);
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const buffer = Buffer.alloc(129);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead < 1 || bytesRead === buffer.length) return null;
    const selector = buffer.subarray(0, bytesRead).toString("utf8").trim();
    if (!/^v?\d+(?:\.\d+){0,2}$/u.test(selector)) return null;
    return selector.replace(/^v/u, "").split(".").map((part) => BigInt(part));
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function nvmVersionComponents(name: string): readonly [bigint, bigint, bigint] {
  const parts = name.replace(/^v/u, "").split(".").map((part) => BigInt(part));
  return [parts[0] ?? 0n, parts[1] ?? 0n, parts[2] ?? 0n];
}

async function boundedNvmExecutableDirectories(
  home: string,
  activeBin: string | undefined,
): Promise<string[]> {
  try {
    const versionsRoot = join(home, ".nvm", "versions", "node");
    const defaultVersion = await boundedNvmDefaultVersion(home);
    const active = activeBin ? resolve(activeBin) : null;
    const versions = await readdir(versionsRoot, {
      withFileTypes: true,
    });
    return versions
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => /^v?\d+(?:\.\d+){0,2}$/u.test(name))
      .map((name) => ({
        bin: join(versionsRoot, name, "bin"),
        components: nvmVersionComponents(name),
      }))
      .sort((left, right) => {
        const activeOrder = Number(active === resolve(right.bin))
          - Number(active === resolve(left.bin));
        if (activeOrder !== 0) return activeOrder;
        const leftDefault = defaultVersion?.every(
          (part, index) => left.components[index] === part,
        ) ?? false;
        const rightDefault = defaultVersion?.every(
          (part, index) => right.components[index] === part,
        ) ?? false;
        if (leftDefault !== rightDefault) return leftDefault ? -1 : 1;
        for (let index = 0; index < left.components.length; index += 1) {
          if (left.components[index] === right.components[index]) continue;
          return left.components[index]! > right.components[index]! ? -1 : 1;
        }
        return left.bin.localeCompare(right.bin);
      })
      .slice(0, 32)
      .map(({ bin }) => bin);
  } catch {
    return [];
  }
}

async function commonExecutableDirectories(
  environment: NodeJS.ProcessEnv,
): Promise<string[]> {
  const home = environmentValue(environment, "USERPROFILE") || homedir();
  if (process.platform === "win32") {
    const local = environmentValue(environment, "LOCALAPPDATA");
    const roaming = environmentValue(environment, "APPDATA");
    const pnpm = environmentValue(environment, "PNPM_HOME");
    const bun = environmentValue(environment, "BUN_INSTALL");
    const volta = environmentValue(environment, "VOLTA_HOME");
    const codexInstall = environmentValue(environment, "CODEX_INSTALL_DIR");
    const codexHome = environmentValue(environment, "CODEX_HOME");
    return unique([
      codexInstall ?? "",
      codexInstall ? join(codexInstall, "bin") : "",
      codexHome ?? "",
      codexHome ? join(codexHome, "bin") : "",
      roaming ? join(roaming, "npm") : "",
      pnpm ?? "",
      local ? join(local, "pnpm") : "",
      bun ? join(bun, "bin") : join(home, ".bun", "bin"),
      volta ? join(volta, "bin") : join(home, ".volta", "bin"),
      local ? join(local, "Programs", "OpenAI", "Codex", "bin") : "",
      local ? join(local, "Programs", "cursor", "resources", "app", "bin") : "",
      join(home, "AppData", "Roaming", "npm"),
    ]);
  }

  return unique([
    join(home, ".local", "bin"),
    join(home, "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".asdf", "shims"),
    join(home, ".local", "share", "mise", "shims"),
    join(home, ".opencode", "bin"),
    ...await boundedNvmExecutableDirectories(
      home,
      environmentValue(environment, "NVM_BIN"),
    ),
    join(home, "Library", "pnpm"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    ...(process.platform === "darwin" ? [
      "/Applications/ChatGPT.app/Contents/Resources",
      "/Applications/Cursor.app/Contents/Resources/app/bin",
    ] : []),
  ]);
}

async function loadProviderEnvironment(): Promise<ProviderEnvironment> {
  const shellEnvironment = await loginShellEnvironment();
  const env = normalizeCodexHomeEnvironment({
    ...process.env,
  });
  const inheritedPath = environmentValue(process.env, "PATH") ?? "";
  const effectivePath = environmentValue(shellEnvironment, "PATH") ?? "";
  const pathEntries = unique([
    ...(effectivePath.split(delimiter)),
    ...(inheritedPath.split(delimiter)),
    ...await commonExecutableDirectories(env),
  ]);
  if (process.platform === "win32") {
    for (const key of Object.keys(env)) {
      if (key !== "PATH" && key.toUpperCase() === "PATH") delete env[key];
    }
  }
  env.PATH = pathEntries.join(delimiter);
  return { env, pathEntries };
}

export function providerEnvironment(refresh = false): Promise<ProviderEnvironment> {
  if (refresh || !environmentPromise) environmentPromise = loadProviderEnvironment();
  return environmentPromise;
}

async function executableFile(path: string): Promise<string | null> {
  try {
    if (process.platform !== "win32") await access(path, fsConstants.X_OK);
    const [details, canonical] = await Promise.all([stat(path), realpath(path).catch(() => path)]);
    return details.isFile() ? canonical : null;
  } catch {
    return null;
  }
}

function commandNames(command: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") return [command];
  if (/\.[A-Za-z0-9]+$/u.test(command)) return [command];
  const extensions = (environmentValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
  return unique([command, ...extensions.map((extension) => `${command}${extension}`)]);
}

export async function executableCandidates(
  command: string,
  environment: ProviderEnvironment,
  cwd = process.cwd(),
): Promise<string[]> {
  const trimmed = command.trim();
  if (!trimmed || trimmed.includes("\0")) return [];

  const candidates = (isAbsolute(trimmed) || trimmed.includes("/") || trimmed.includes("\\"))
    ? [isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed)]
    : environment.pathEntries.flatMap((directory) => commandNames(trimmed, environment.env).map((name) => join(directory, name)));

  const resolved = await Promise.all(unique(candidates).map(executableFile));
  return unique(resolved.filter((value): value is string => value !== null));
}
