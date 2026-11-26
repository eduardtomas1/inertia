import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  type Stats,
} from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { FILE_OPEN_NO_FOLLOW } from "../../../node/platform-file-open-flags";
import { AGENT_SECRET_MAX_LENGTH } from "../../../shared/agent-secrets";
import { isAgentSecretValue, isSecretRequestFileName } from "../../../node/agent-secrets";

export const AGENT_SECRETS_DIRECTORY = "agent-secrets";

const FILE_TOKEN = /^[0-9a-f]{32}$/u;
const PARTIAL_SUFFIX = ".partial";
const MAX_RETAINED_TOKENS = 128;
const MAX_RETAINED_FILES_PER_TOKEN = 4;
const MAX_RETAINED_FILE_BYTES = AGENT_SECRET_MAX_LENGTH * 4;
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
const WIN32_RENAME_MAX_ATTEMPTS = 5;
const WIN32_RENAME_RETRY_DELAYS_MS = [25, 50, 75, 100] as const;
const WIN32_TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EBUSY", "EACCES"]);
const WINDOWS_DACL_COMMAND_TIMEOUT_MS = 25_000;
const MAX_HARDENED_ROOTS_CACHE = 64;
const WINDOWS_DACL_ENV_VAR = "INERTIA_AGENT_SECRET_ROOT";
const WINDOWS_DACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$PSModuleAutoLoadingPreference = 'None'",
  `$target = $env:${WINDOWS_DACL_ENV_VAR}`,
  "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "if (-not $sid) { throw 'Missing current user SID' }",
  "$acl = [System.Security.AccessControl.DirectorySecurity]::new()",
  "$acl.SetAccessRuleProtection($true, $false)",
  "$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'",
  "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)",
  "$acl.SetAccessRule($rule)",
  "[System.IO.Directory]::SetAccessControl($target, $acl)",
].join("; ");
const WINDOWS_DACL_ENCODED_COMMAND = Buffer.from(WINDOWS_DACL_SCRIPT, "utf16le").toString("base64");

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === target && typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

const WINDOWS_DACL_ALLOWED_ENV_KEYS = [
  "ALLUSERSPROFILE",
  "APPDATA",
  "COMPUTERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "OS",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "TEMP",
  "TMP",
  "USERNAME",
  "USERPROFILE",
] as const;

function trustedWindowsSystemRoot(source: NodeJS.ProcessEnv): string | null {
  const raw = environmentValue(source, "SystemRoot") ?? environmentValue(source, "WINDIR");
  if (!raw) return null;
  const normalized = raw.replace(/[\\/]+$/u, "");
  if (!/^[a-z]:\\/iu.test(normalized) || normalized.includes("..")) return null;
  return normalized;
}

export type AgentSecretExecFileOptions = {
  encoding: "utf8";
  shell: false;
  windowsHide: true;
  stdio: ["ignore", "pipe", "pipe"];
  timeout: number;
  env?: NodeJS.ProcessEnv;
};

export type AgentSecretExecFileSync = (
  file: string,
  args: readonly string[],
  options: AgentSecretExecFileOptions,
) => string;

export type AgentSecretExecFileAsync = (
  file: string,
  args: readonly string[],
  options: AgentSecretExecFileOptions,
) => Promise<string>;

export interface WindowsDaclCache {
  hardenedRoots: Map<string, string>;
}

export interface EnsureAgentSecretRootOptions {
  platform?: NodeJS.Platform;
  execFile?: AgentSecretExecFileSync;
  windowsDaclCache?: WindowsDaclCache;
  hardenWindowsDacl?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface EnsureAgentSecretRootAsyncOptions extends EnsureAgentSecretRootOptions {
  execFileAsync?: AgentSecretExecFileAsync;
}

export interface WriteAgentSecretFileOptions extends Omit<EnsureAgentSecretRootAsyncOptions, "hardenWindowsDacl"> {
  renameFile?: (oldPath: string, newPath: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

const WINDOWS_DACL_ARGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-InputFormat",
  "None",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
  WINDOWS_DACL_ENCODED_COMMAND,
] as const;

const defaultWindowsDaclCache: WindowsDaclCache = {
  hardenedRoots: new Map<string, string>(),
};
const inFlightWindowsDaclHardening = new WeakMap<WindowsDaclCache, Map<string, Promise<void>>>();

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function windowsDaclLaunchConfig(
  resolvedRoot: string,
  source: NodeJS.ProcessEnv = process.env,
): { executable: string; options: AgentSecretExecFileOptions } {
  const systemRoot = trustedWindowsSystemRoot(source);
  if (!systemRoot) {
    throw new Error("Could not harden Windows permissions on the agent secret directory.");
  }
  const env: NodeJS.ProcessEnv = {
    ComSpec: `${systemRoot}\\System32\\cmd.exe`,
    PATH: `${systemRoot}\\System32;${systemRoot};${systemRoot}\\System32\\WindowsPowerShell\\v1.0`,
    SystemRoot: systemRoot,
    SYSTEMROOT: systemRoot,
    WINDIR: systemRoot,
    SystemDrive: systemRoot.slice(0, 2),
    PSModulePath: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\Modules`,
  };
  for (const key of WINDOWS_DACL_ALLOWED_ENV_KEYS) {
    const value = environmentValue(source, key);
    if (value !== undefined) env[key] = value;
  }
  env[WINDOWS_DACL_ENV_VAR] = resolvedRoot;
  return {
    executable: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    options: {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: WINDOWS_DACL_COMMAND_TIMEOUT_MS,
      env,
    },
  };
}

function defaultExecFile(
  file: string,
  args: readonly string[],
  options: AgentSecretExecFileOptions,
): string {
  return execFileSync(file, args, options);
}

function defaultExecFileAsync(
  file: string,
  args: readonly string[],
  options: AgentSecretExecFileOptions,
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    // Use an immediately-closed pipe for stdin (matching windows-runtime-job.ts)
    // so PowerShell inside Electron's headless utilityProcess always receives a
    // valid EOF handle, and settle promptly after "exit" if a Windows helper
    // handle keeps stdout/stderr pipes open past process termination.
    const child = spawn(file, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env,
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let closeGrace: ReturnType<typeof setTimeout> | null = null;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (closeGrace) clearTimeout(closeGrace);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(stdout);
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 4096) stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk;
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
      }
      finish(new Error(`Timed out after ${options.timeout}ms`));
    }, options.timeout);
    timer.unref?.();
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      closeGrace = setTimeout(() => {
        if (code === 0) finish(null);
        else finish(new Error(stderr.trim() || `Exited with ${signal ?? code ?? "unknown"}`));
      }, 250);
      closeGrace.unref?.();
    });
    child.once("close", (code, signal) => {
      if (code === 0) finish(null);
      else finish(new Error(stderr.trim() || `Exited with ${signal ?? code ?? "unknown"}`));
    });
  });
}

function directoryIdentity(path: string): string | null {
  try {
    const stats = lstatSync(path, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) return null;
    return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
  } catch {
    return null;
  }
}

function prepareWindowsDaclHardening(
  resolvedRoot: string,
  existed: boolean,
  options?: EnsureAgentSecretRootOptions,
): { cache: WindowsDaclCache; identity: string } | null {
  const platform = options?.platform ?? process.platform;
  if (platform !== "win32") return null;
  const cache = options?.windowsDaclCache ?? defaultWindowsDaclCache;
  const identity = directoryIdentity(resolvedRoot);
  if (!identity) {
    cache.hardenedRoots.delete(resolvedRoot);
    throw new Error("The agent secret root must be a real directory.");
  }
  if (existed && cache.hardenedRoots.get(resolvedRoot) === identity) return null;
  // Invalidate any stale entry before attempting hardening so a failed attempt
  // never leaves a previously hardened identity cached for this path.
  cache.hardenedRoots.delete(resolvedRoot);
  return { cache, identity };
}

function commitWindowsDaclHardening(
  resolvedRoot: string,
  cache: WindowsDaclCache,
  identity: string,
): void {
  const afterIdentity = directoryIdentity(resolvedRoot);
  if (!afterIdentity || afterIdentity !== identity) {
    throw new Error("Could not harden Windows permissions on the agent secret directory.");
  }
  cache.hardenedRoots.set(resolvedRoot, afterIdentity);
  while (cache.hardenedRoots.size > MAX_HARDENED_ROOTS_CACHE) {
    const oldest = cache.hardenedRoots.keys().next().value;
    if (oldest === undefined) break;
    cache.hardenedRoots.delete(oldest);
  }
}

function hardenWindowsDirectoryDacl(
  resolvedRoot: string,
  existed: boolean,
  options?: EnsureAgentSecretRootOptions,
): void {
  const prepared = prepareWindowsDaclHardening(resolvedRoot, existed, options);
  if (!prepared) return;
  const execFile = options?.execFile ?? defaultExecFile;
  const launch = windowsDaclLaunchConfig(resolvedRoot, options?.env);
  try {
    // Apply a protected, current-user-only DACL directly from memory via the
    // .NET/Win32 DirectorySecurity API (no temporary ACL file or /reset window).
    execFile(launch.executable, WINDOWS_DACL_ARGS, launch.options);
  } catch (error) {
    throw new Error("Could not harden Windows permissions on the agent secret directory.", { cause: error });
  }
  commitWindowsDaclHardening(resolvedRoot, prepared.cache, prepared.identity);
}

async function hardenWindowsDirectoryDaclAsync(
  resolvedRoot: string,
  existed: boolean,
  options?: EnsureAgentSecretRootAsyncOptions,
): Promise<void> {
  const prepared = prepareWindowsDaclHardening(resolvedRoot, existed, options);
  if (!prepared) return;
  let cacheInFlight = inFlightWindowsDaclHardening.get(prepared.cache);
  if (!cacheInFlight) {
    cacheInFlight = new Map<string, Promise<void>>();
    inFlightWindowsDaclHardening.set(prepared.cache, cacheInFlight);
  }
  const key = `${resolvedRoot}\0${prepared.identity}`;
  const existing = cacheInFlight.get(key);
  if (existing) {
    await existing;
    return;
  }
  let settled = false;
  let task: Promise<void> | undefined;
  task = (async () => {
    try {
      const launch = windowsDaclLaunchConfig(resolvedRoot, options?.env);
      try {
        if (options?.execFileAsync) {
          await options.execFileAsync(launch.executable, WINDOWS_DACL_ARGS, launch.options);
        } else if (options?.execFile) {
          options.execFile(launch.executable, WINDOWS_DACL_ARGS, launch.options);
        } else {
          await defaultExecFileAsync(launch.executable, WINDOWS_DACL_ARGS, launch.options);
        }
      } catch (error) {
        throw new Error("Could not harden Windows permissions on the agent secret directory.", { cause: error });
      }
      commitWindowsDaclHardening(resolvedRoot, prepared.cache, prepared.identity);
    } finally {
      settled = true;
      if (cacheInFlight.get(key) === task) cacheInFlight.delete(key);
    }
  })();
  if (!settled) cacheInFlight.set(key, task);
  await task;
}

async function renameWithWin32Retry(
  oldPath: string,
  newPath: string,
  options?: WriteAgentSecretFileOptions,
): Promise<void> {
  const platform = options?.platform ?? process.platform;
  const renameFile = options?.renameFile ?? rename;
  if (platform !== "win32") {
    await renameFile(oldPath, newPath);
    return;
  }
  const sleep = options?.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renameFile(oldPath, newPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        attempt >= WIN32_RENAME_MAX_ATTEMPTS
        || typeof code !== "string"
        || !WIN32_TRANSIENT_RENAME_ERRORS.has(code)
      ) {
        throw error;
      }
      const delay = WIN32_RENAME_RETRY_DELAYS_MS[
        Math.min(attempt - 1, WIN32_RENAME_RETRY_DELAYS_MS.length - 1)
      ]!;
      await sleep(delay);
    }
  }
}

function existingDirectoryStatus(path: string): "missing" | "directory" | "unsafe" {
  try {
    const stats = lstatSync(path);
    return stats.isDirectory() && !stats.isSymbolicLink() ? "directory" : "unsafe";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "unsafe";
  }
}

export function agentSecretRoot(dataDirectory: string): string {
  return join(dataDirectory, AGENT_SECRETS_DIRECTORY);
}

export function newAgentSecretFileToken(): string {
  return randomBytes(16).toString("hex");
}

export function isAgentSecretFileToken(value: unknown): value is string {
  return typeof value === "string" && FILE_TOKEN.test(value);
}

export function agentSecretFilePath(root: string, token: string, fileName: string): string {
  if (!isAgentSecretFileToken(token) || !isSecretRequestFileName(fileName)) {
    throw new Error("Invalid agent secret file location.");
  }
  return join(root, token, fileName);
}

function ensureAgentSecretRootBase(root: string, options?: EnsureAgentSecretRootOptions): { resolvedRoot: string; existed: boolean } {
  const resolvedRoot = resolve(root);
  const parentStatus = existingDirectoryStatus(dirname(resolvedRoot));
  const rootStatus = existingDirectoryStatus(resolvedRoot);
  if (parentStatus === "unsafe" || rootStatus === "unsafe") {
    throw new Error("The agent secret root must be a real directory.");
  }
  if (rootStatus !== "directory") {
    (options?.windowsDaclCache ?? defaultWindowsDaclCache).hardenedRoots.delete(resolvedRoot);
  }
  mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
  if (!realRoot(resolvedRoot)) throw new Error("The agent secret root must be a real directory.");
  chmodSync(resolvedRoot, 0o700);
  return { resolvedRoot, existed: rootStatus === "directory" };
}

export function ensureAgentSecretRoot(root: string, options?: EnsureAgentSecretRootOptions): void {
  const { resolvedRoot, existed } = ensureAgentSecretRootBase(root, options);
  if (options?.hardenWindowsDacl !== false) {
    hardenWindowsDirectoryDacl(resolvedRoot, existed, options);
  }
}

export async function ensureAgentSecretRootAsync(
  root: string,
  options?: EnsureAgentSecretRootAsyncOptions,
): Promise<void> {
  const { resolvedRoot, existed } = ensureAgentSecretRootBase(root, options);
  if (options?.hardenWindowsDacl !== false) {
    await hardenWindowsDirectoryDaclAsync(resolvedRoot, existed, options);
  }
}

function realRoot(root: string): boolean {
  try {
    const resolvedRoot = resolve(root);
    const parent = dirname(resolvedRoot);
    const rootStats = lstatSync(resolvedRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return false;
    const parentStats = lstatSync(parent);
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) return false;
    const realParent = realpathSync(parent);
    const realTarget = realpathSync(resolvedRoot);
    if (realTarget !== join(realParent, basename(resolvedRoot))) return false;
    const grandParent = dirname(parent);
    if (grandParent !== parent) {
      const realGrandParent = realpathSync(grandParent);
      if (realParent !== join(realGrandParent, basename(parent))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r").catch(() => null);
  try {
    await handle?.sync().catch(() => undefined);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeAgentSecretFile(
  root: string,
  token: string,
  fileName: string,
  value: string,
  options?: WriteAgentSecretFileOptions,
): Promise<string> {
  const target = agentSecretFilePath(root, token, fileName);
  const directory = join(root, token);
  await ensureAgentSecretRootAsync(root, {
    platform: options?.platform,
    execFile: options?.execFile,
    execFileAsync: options?.execFileAsync,
    windowsDaclCache: options?.windowsDaclCache,
    env: options?.env,
    hardenWindowsDacl: true,
  });
  await rm(directory, RM_OPTIONS);
  try {
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
    const partial = `${target}.partial`;
    const handle = await open(partial, "wx", 0o600);
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithWin32Retry(partial, target, options);
    await chmod(target, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await rm(directory, RM_OPTIONS).catch(() => undefined);
    throw error;
  }
  return target;
}

export function removeAgentSecretDirectory(root: string, token: string): void {
  if (!isAgentSecretFileToken(token)) return;
  if (!realRoot(root)) throw new Error("The agent secret root must be a real directory.");
  rmSync(join(root, token), RM_OPTIONS);
}

export async function removeAgentSecretDirectoryAsync(root: string, token: string): Promise<void> {
  if (!isAgentSecretFileToken(token)) return;
  if (!realRoot(root)) throw new Error("The agent secret root must be a real directory.");
  await rm(join(root, token), RM_OPTIONS);
}

export function clearAgentSecretRoot(root: string, keep: ReadonlySet<string> = new Set()): void {
  if (!realRoot(root)) return;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (keep.has(entry)) continue;
    try {
      rmSync(join(root, entry), RM_OPTIONS);
    } catch {
    }
  }
}

export function retainedAgentSecretTokens(root: string): string[] {
  if (!realRoot(root)) return [];
  try {
    return readdirSync(root).filter(isAgentSecretFileToken).slice(0, MAX_RETAINED_TOKENS);
  } catch {
    return [];
  }
}

function privatelyOwned(stats: Stats, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return true;
  return stats.uid === process.getuid?.() && (stats.mode & 0o077) === 0;
}

function retainedFileName(name: string): boolean {
  const base = name.endsWith(PARTIAL_SUFFIX) ? name.slice(0, -PARTIAL_SUFFIX.length) : name;
  return isSecretRequestFileName(base);
}

function readRetainedFile(path: string, platform: NodeJS.Platform): string | null {
  const before = lstatSync(path);
  if (!before.isFile() || before.nlink !== 1 || before.size > MAX_RETAINED_FILE_BYTES || !privatelyOwned(before, platform)) {
    return null;
  }
  const descriptor = openSync(path, constants.O_RDONLY | FILE_OPEN_NO_FOLLOW | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_RETAINED_FILE_BYTES) {
      return null;
    }
    const buffer = Buffer.alloc(opened.size);
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(descriptor, buffer, read, buffer.length - read, read);
      if (count === 0) break;
      read += count;
    }
    const value = buffer.subarray(0, read).toString("utf8");
    return isAgentSecretValue(value) ? value : null;
  } finally {
    closeSync(descriptor);
  }
}

export function readRetainedAgentSecretValues(
  root: string,
  token: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (!isAgentSecretFileToken(token)) return [];
  if (!realRoot(root)) return [];
  try {
    const directory = join(root, token);
    const directoryStats = lstatSync(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink() || !privatelyOwned(directoryStats, platform)) {
      return [];
    }
    const values = new Set<string>();
    for (const name of readdirSync(directory).filter(retainedFileName).slice(0, MAX_RETAINED_FILES_PER_TOKEN)) {
      try {
        const value = readRetainedFile(join(directory, name), platform);
        if (value !== null) values.add(value);
      } catch {
      }
    }
    return [...values];
  } catch {
    return [];
  }
}
