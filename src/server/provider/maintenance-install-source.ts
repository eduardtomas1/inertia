import { constants } from "node:fs";
import { access, lstat, open, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import { FILE_OPEN_NO_FOLLOW } from "../../node/platform-file-open-flags";
import {
  environmentValue,
  executableCandidates,
  expandHomePath,
  type ProviderEnvironment,
} from "../environment";
import type {
  ProviderMaintenanceInstallMethod,
  ProviderMaintenanceProviderId,
} from "../../shared/provider-maintenance";
import { cursorAgentCommandArgs } from "./cursor-command";

const MAX_SCRIPT_BYTES = 16 * 1024;
const SAFE_TOKEN = /^[A-Za-z0-9._/~@+=:-]+$/u;
const SNAP_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/u;

export const PROVIDER_MAINTENANCE_ENVIRONMENT_KEYS = [
  "BUN_INSTALL",
  "CODEX_HOME",
  "PNPM_HOME",
  "UV_TOOL_DIR",
  "VOLTA_HOME",
] as const;

export type ProviderMaintenanceEnvironmentKey =
  (typeof PROVIDER_MAINTENANCE_ENVIRONMENT_KEYS)[number];

export interface ProviderMaintenanceVersionPin {
  major: number;
  argumentIndex: number | null;
  command: string | null;
}

export interface ProviderInstallUpdateAction {
  executable: string;
  args: readonly string[];
  environment?: Partial<Record<ProviderMaintenanceEnvironmentKey, string>>;
  environmentPathPrefix?: string;
  lockKey: string;
  installMethod: ProviderMaintenanceInstallMethod;
  label: string;
  versionPin?: ProviderMaintenanceVersionPin;
}

export interface HomebrewLatestSource {
  brew: string;
  name: string;
  cask: boolean;
}

export interface ProviderInstallSource {
  installMethod: ProviderMaintenanceInstallMethod;
  update: ProviderInstallUpdateAction | null;
  manualCommand: string | null;
  message: string | null;
  homebrew?: HomebrewLatestSource;
}

export interface ProviderInstallSourceInput {
  providerId: ProviderMaintenanceProviderId;
  executable: string;
  environment: ProviderEnvironment;
}

interface FileInfo {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface ProviderInstallSourceDependencies {
  platform?: NodeJS.Platform;
  home?: string;
  access?: (path: string, mode: number) => Promise<void>;
  realpath?: (path: string) => Promise<string>;
  lstat?: (path: string) => Promise<FileInfo>;
  readScript?: (path: string) => Promise<string | null>;
  readlink?: (path: string) => Promise<string>;
  executableCandidates?: typeof executableCandidates;
  packageSpec?: (
    providerId: ProviderMaintenanceProviderId,
    packageName: string,
    spec: string,
  ) => string;
}

interface HomebrewName {
  kind: "formula" | "cask";
  name: string;
}

interface ProviderInstallDefinition {
  label: string;
  packageName: string | null;
  packageRange: string;
  commands: readonly string[];
  homebrew: readonly HomebrewName[];
  allowScripts: readonly string[];
  uvTool: string | null;
}

const DEFINITIONS: Readonly<
  Record<ProviderMaintenanceProviderId, ProviderInstallDefinition>
> = {
  codex: {
    label: "Codex",
    packageName: "@openai/codex",
    packageRange: "latest",
    commands: ["codex"],
    homebrew: [{ kind: "formula", name: "codex" }, { kind: "cask", name: "codex" }],
    allowScripts: [],
    uvTool: null,
  },
  claude: {
    label: "Claude",
    packageName: "@anthropic-ai/claude-code",
    packageRange: "latest",
    commands: ["claude"],
    homebrew: [{ kind: "cask", name: "claude-code" }],
    allowScripts: ["@anthropic-ai/claude-code"],
    uvTool: null,
  },
  cursor: {
    label: "Cursor",
    packageName: null,
    packageRange: "latest",
    commands: ["cursor-agent", "agent", "cursor"],
    homebrew: [],
    allowScripts: [],
    uvTool: null,
  },
  kimi: {
    label: "Kimi",
    packageName: "@moonshot-ai/kimi-code",
    packageRange: "latest",
    commands: ["kimi"],
    homebrew: [],
    allowScripts: ["@moonshot-ai/kimi-code", "node-pty"],
    uvTool: "kimi-cli",
  },
  opencode: {
    label: "OpenCode",
    packageName: "opencode-ai",
    packageRange: "1",
    commands: ["opencode"],
    homebrew: [{ kind: "formula", name: "opencode" }],
    allowScripts: ["opencode-ai"],
    uvTool: null,
  },
  antigravity: {
    label: "Antigravity",
    packageName: null,
    packageRange: "latest",
    commands: ["agy", "antigravity"],
    homebrew: [],
    allowScripts: [],
    uvTool: null,
  },
};

const SYSTEM_PREFIXES = [
  "/usr",
  "/usr/local",
  "/opt/homebrew",
  "/opt/local",
  "/home/linuxbrew/.linuxbrew",
] as const;

const SUDO_PREFIXES: readonly string[] = ["/usr", "/usr/local", "/opt/local"];

const SYSTEM_PACKAGE_ROOTS = [
  "/bin/",
  "/sbin/",
  "/usr/bin/",
  "/usr/sbin/",
  "/usr/lib/",
  "/usr/lib64/",
  "/usr/libexec/",
  "/usr/share/",
  "/nix/store/",
  "/run/current-system/",
] as const;

export function providerInstallPackageName(
  providerId: ProviderMaintenanceProviderId,
): string | null {
  return DEFINITIONS[providerId].packageName;
}

async function boundedScript(path: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : FILE_OPEN_NO_FOLLOW),
    );
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SCRIPT_BYTES) return null;
    const buffer = Buffer.alloc(MAX_SCRIPT_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > MAX_SCRIPT_BYTES
      ? null
      : buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

class InstallSourceContext {
  readonly platform: NodeJS.Platform;
  readonly path: typeof posix;
  readonly home: string;
  readonly definition: ProviderInstallDefinition;
  readonly realpath: (path: string) => Promise<string>;
  readonly lstat: (path: string) => Promise<FileInfo>;
  readonly access: (path: string, mode: number) => Promise<void>;
  readonly readScript: (path: string) => Promise<string | null>;
  readonly readlink: (path: string) => Promise<string>;
  readonly candidates: typeof executableCandidates;
  hit: string;
  real: string;

  constructor(
    readonly input: ProviderInstallSourceInput,
    readonly dependencies: ProviderInstallSourceDependencies,
  ) {
    this.platform = dependencies.platform ?? process.platform;
    this.path = this.platform === "win32" ? win32 : posix;
    this.home = dependencies.home ?? homedir();
    this.definition = DEFINITIONS[input.providerId];
    this.realpath = dependencies.realpath ?? realpath;
    this.lstat = dependencies.lstat ?? lstat;
    this.access = dependencies.access ?? access;
    this.readScript = dependencies.readScript ?? boundedScript;
    this.readlink = dependencies.readlink ?? readlink;
    this.candidates = dependencies.executableCandidates ?? executableCandidates;
    this.hit = input.executable;
    this.real = input.executable;
  }

  key(value: string): string {
    const slashed = value.replaceAll("\\", "/");
    return this.platform === "win32" ? slashed.toLocaleLowerCase("en-US") : slashed;
  }

  same(left: string, right: string): boolean {
    return this.key(left) === this.key(right);
  }

  under(value: string, directory: string): boolean {
    const root = this.key(directory).replace(/\/+$/u, "");
    return this.key(value).startsWith(`${root}/`);
  }

  env(key: string): string | undefined {
    const value = environmentValue(this.input.environment.env, key, this.platform);
    return value ? expandHomePath(value) : undefined;
  }

  join(...parts: string[]): string {
    return this.path.join(...parts);
  }

  async resolved(path: string): Promise<string | null> {
    try {
      return await this.realpath(path);
    } catch {
      return null;
    }
  }

  async exists(path: string, kind: "file" | "directory" | "any" = "any"): Promise<boolean> {
    try {
      const info = await this.lstat(path);
      if (kind === "directory") return info.isDirectory();
      if (kind === "file") return info.isFile() || info.isSymbolicLink();
      return true;
    } catch {
      return false;
    }
  }

  async runnable(path: string): Promise<boolean> {
    if (!await this.exists(path, "file")) return false;
    if (this.platform === "win32") return true;
    try {
      await this.access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  async writable(paths: readonly string[]): Promise<boolean> {
    try {
      for (const path of paths) await this.access(path, constants.W_OK | constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  commandNames(): string[] {
    if (this.platform !== "win32") return [...this.definition.commands];
    return this.definition.commands.flatMap((command) =>
      [".exe", ".cmd", ".bat", ""].map((extension) => `${command}${extension}`));
  }

  spec(): string {
    const packageName = this.definition.packageName!;
    const spec = `${packageName}@${this.definition.packageRange}`;
    return this.dependencies.packageSpec?.(this.input.providerId, packageName, spec) ?? spec;
  }

  display(path: string): string | null {
    const normalized = this.key(path).replace(/\/+$/u, "");
    if (SYSTEM_PREFIXES.some((prefix) => normalized === prefix)) {
      return SAFE_TOKEN.test(normalized) ? normalized : null;
    }
    if (this.under(path, this.home)) {
      const relative = this.key(path).slice(this.key(this.home).replace(/\/+$/u, "").length + 1);
      const display = `~/${relative}`;
      return SAFE_TOKEN.test(display) ? display : null;
    }
    return null;
  }

  async resolvePathHit(): Promise<void> {
    this.real = await this.resolved(this.input.executable) ?? this.input.executable;
    if (!this.same(this.real, this.input.executable)) return;
    for (const directory of this.input.environment.pathEntries.slice(0, 256)) {
      if (!directory || !this.path.isAbsolute(directory)) continue;
      for (const name of this.commandNames()) {
        const candidate = this.join(directory, name);
        if (!await this.exists(candidate)) continue;
        const resolved = await this.resolved(candidate);
        if (resolved && this.same(resolved, this.real)) {
          this.hit = candidate;
          return;
        }
      }
    }
  }
}

function update(
  context: InstallSourceContext,
  installMethod: ProviderMaintenanceInstallMethod,
  action: Omit<ProviderInstallUpdateAction, "installMethod" | "label">,
  manager: string | null,
  manualCommand: string | null,
): ProviderInstallSource {
  const range = context.definition.packageRange;
  return {
    installMethod,
    update: {
      ...action,
      ...(!action.versionPin && /^\d+$/u.test(range)
        ? { versionPin: { major: Number(range), argumentIndex: null, command: null } }
        : {}),
      installMethod,
      label: `Update ${context.definition.label}${manager ? ` with ${manager}` : ""}`,
    },
    manualCommand,
    message: null,
  };
}

function manual(
  installMethod: ProviderMaintenanceInstallMethod,
  message: string,
  manualCommand: string | null = null,
): ProviderInstallSource {
  return { installMethod, update: null, manualCommand, message };
}

function nativeSource(context: InstallSourceContext): ProviderInstallSource | null {
  const { home, real, hit, platform } = context;
  const providerId = context.input.providerId;
  const native = (
    args: readonly string[],
    manualCommand: string | null,
    extra: Partial<ProviderInstallUpdateAction> = {},
  ): ProviderInstallSource => update(context, "provider-managed", {
    executable: hit,
    args,
    lockKey: `native:${providerId}`,
    ...extra,
  }, null, manualCommand);
  if (providerId === "codex") {
    const configuredHome = context.env("CODEX_HOME");
    const codexHome = configuredHome ?? context.join(home, ".codex");
    if (!context.under(real, context.join(codexHome, "packages", "standalone"))) return null;
    return native(["update"], "codex update", configuredHome
      ? { environment: { CODEX_HOME: configuredHome } }
      : {});
  }
  if (providerId === "claude") {
    if (
      !context.under(real, context.join(home, ".local", "share", "claude"))
      && !context.under(real, context.join(home, ".claude", "local"))
      && !(platform === "win32" && context.same(real, context.join(home, ".local", "bin", "claude.exe")))
    ) return null;
    return native(["update"], "claude update");
  }
  if (providerId === "cursor") {
    if (!context.under(real, context.join(home, ".local", "share", "cursor-agent", "versions"))) {
      return null;
    }
    return native(cursorAgentCommandArgs(hit, ["update"]), "cursor-agent update");
  }
  if (providerId === "opencode") {
    const binary = context.join(home, ".opencode", "bin", platform === "win32" ? "opencode.exe" : "opencode");
    if (!context.same(real, binary)) return null;
    return native(["upgrade", "--method", "curl"], null, {
      versionPin: { major: 1, argumentIndex: 1, command: "opencode" },
    });
  }
  if (providerId === "antigravity") {
    const local = context.env("LOCALAPPDATA");
    const binary = platform === "win32"
      ? local ? context.join(local, "agy", "bin", "agy.exe") : null
      : context.join(home, ".local", "bin", "agy");
    if (!binary || !context.same(real, binary)) return null;
    return native(["update"], "agy update");
  }
  return null;
}

async function bunSource(
  context: InstallSourceContext,
  packageName: string,
): Promise<ProviderInstallSource | null> {
  const bunHome = context.env("BUN_INSTALL") ?? context.join(context.home, ".bun");
  const packageRoot = context.join(bunHome, "install", "global", "node_modules", ...packageName.split("/"));
  if (!context.under(context.real, packageRoot)) return null;
  const bun = context.join(bunHome, "bin", context.platform === "win32" ? "bun.exe" : "bun");
  const args = ["add", "-g", ...(context.definition.allowScripts.length > 0 ? ["--trust"] : []), context.spec()];
  const manualCommand = ["bun", ...args].join(" ");
  if (!await context.runnable(bun)) {
    return manual("bun-global", "Inertia could not find the bun that installed this CLI.", manualCommand);
  }
  return update(context, "bun-global", {
    executable: bun,
    args,
    environment: { BUN_INSTALL: bunHome },
    lockKey: `bun-global:${bunHome}`,
  }, "bun", manualCommand);
}

function defaultPnpmHome(context: InstallSourceContext): string | null {
  if (context.platform === "win32") {
    const local = context.env("LOCALAPPDATA");
    return local ? context.join(local, "pnpm") : null;
  }
  return context.platform === "darwin"
    ? context.join(context.home, "Library", "pnpm")
    : context.join(context.env("XDG_DATA_HOME") ?? context.join(context.home, ".local", "share"), "pnpm");
}

async function pnpmSource(
  context: InstallSourceContext,
  packageName: string,
): Promise<ProviderInstallSource | null> {
  const pnpmHome = context.env("PNPM_HOME") ?? defaultPnpmHome(context);
  if (
    !pnpmHome
    || !context.same(context.path.dirname(context.hit), pnpmHome)
    || !context.same(context.hit, context.real)
  ) return null;
  const script = await context.readScript(context.real);
  const pattern = new RegExp(
    `(?:\\$basedir|%~dp0|%dp0%)[\\\\/]global[\\\\/](\\d{1,3})[\\\\/]node_modules[\\\\/]${packageName.split("/").map(escapedPattern).join("[\\\\/]")}[\\\\/]`,
    "u",
  );
  const layout = script ? pattern.exec(script)?.[1] : undefined;
  if (
    !layout
    || !await context.exists(
      context.join(pnpmHome, "global", layout, "node_modules", ...packageName.split("/")),
      "directory",
    )
  ) return null;
  const args = [
    "add",
    "-g",
    ...context.definition.allowScripts.map((name) => `--allow-build=${name}`),
    context.spec(),
  ];
  const manualCommand = ["pnpm", ...args].join(" ");
  const owned = context.join(pnpmHome, context.platform === "win32" ? "pnpm.exe" : "pnpm");
  const pnpm = await context.runnable(owned)
    ? owned
    : (await context.candidates("pnpm", context.input.environment))[0];
  if (!pnpm) {
    return manual("pnpm-global", "Inertia could not find pnpm to update this CLI.", manualCommand);
  }
  return update(context, "pnpm-global", {
    executable: pnpm,
    args,
    environment: { PNPM_HOME: pnpmHome },
    lockKey: `pnpm-global:${pnpmHome}`,
  }, "pnpm", manualCommand);
}

async function yarnSource(
  context: InstallSourceContext,
  packageName: string,
): Promise<ProviderInstallSource | null> {
  const local = context.env("LOCALAPPDATA");
  const globalDirectory = context.platform === "win32"
    ? local ? context.join(local, "Yarn", "Data", "global") : null
    : context.join(context.env("XDG_CONFIG_HOME") ?? context.join(context.home, ".config"), "yarn", "global");
  if (
    !globalDirectory
    || !context.under(
      context.real,
      context.join(globalDirectory, "node_modules", ...packageName.split("/")),
    )
  ) return null;
  const args = ["global", "add", context.spec()];
  const manualCommand = ["yarn", ...args].join(" ");
  const yarn = (await context.candidates("yarn", context.input.environment))[0];
  if (!yarn) {
    return manual("yarn-global", "Inertia could not find yarn to update this CLI.", manualCommand);
  }
  return update(context, "yarn-global", {
    executable: yarn,
    args,
    lockKey: `yarn-global:${globalDirectory}`,
  }, "yarn", manualCommand);
}

async function uvToolSource(context: InstallSourceContext): Promise<ProviderInstallSource | null> {
  const tool = context.definition.uvTool;
  if (!tool || context.platform === "win32") return null;
  const configured = context.env("UV_TOOL_DIR");
  const toolDirectory = configured
    ?? context.join(context.env("XDG_DATA_HOME") ?? context.join(context.home, ".local", "share"), "uv", "tools");
  if (!context.under(context.real, context.join(toolDirectory, tool))) return null;
  if (tool === "kimi-cli") {
    return manual(
      "uv-tool",
      "kimi-cli is no longer maintained, and upgrading it installs a placeholder. Install Kimi Code instead.",
      "npm install -g @moonshot-ai/kimi-code",
    );
  }
  const args = ["tool", "upgrade", tool];
  const manualCommand = ["uv", ...args].join(" ");
  const uv = (await context.candidates("uv", context.input.environment))[0];
  if (!uv) {
    return manual("uv-tool", "Inertia could not find uv to update this CLI.", manualCommand);
  }
  return update(context, "uv-tool", {
    executable: uv,
    args,
    ...(configured ? { environment: { UV_TOOL_DIR: configured } } : {}),
    lockKey: `uv-tool:${toolDirectory}`,
  }, "uv", manualCommand);
}

async function voltaSource(
  context: InstallSourceContext,
  packageName: string,
): Promise<ProviderInstallSource | null> {
  const voltaHome = context.env("VOLTA_HOME") ?? context.join(context.home, ".volta");
  const shim = context.path.basename(context.key(context.real)).replace(/\.exe$/u, "");
  if (
    shim !== "volta-shim"
    || !context.same(context.path.dirname(context.hit), context.join(voltaHome, "bin"))
    || !await context.exists(
      context.join(voltaHome, "tools", "image", "packages", ...packageName.split("/")),
      "directory",
    )
  ) return null;
  const args = ["install", context.spec()];
  const manualCommand = ["volta", ...args].join(" ");
  const volta = context.join(voltaHome, "bin", context.platform === "win32" ? "volta.exe" : "volta");
  if (!await context.runnable(volta)) {
    return manual("volta", "Inertia could not find the Volta that installed this CLI.", manualCommand);
  }
  return update(context, "volta", {
    executable: volta,
    args,
    environment: { VOLTA_HOME: voltaHome },
    lockKey: `volta:${voltaHome}`,
  }, "Volta", manualCommand);
}

function versionManagerSource(context: InstallSourceContext): ProviderInstallSource | null {
  const paths = [context.key(context.hit), context.key(context.real)];
  const packageName = context.definition.packageName;
  const miseInstall = /\/mise\/installs\/([^/]+)\//u.exec(paths[1]!)?.[1];
  if (miseInstall === "node") return null;
  const mise = miseInstall !== undefined
    || paths.some((path) => path.includes("/mise/shims/"))
    || context.path.basename(paths[1]!).replace(/\.exe$/u, "") === "mise";
  if (mise) {
    const npmTool = packageName
      && miseInstall === `npm-${packageName.replace(/^@/u, "").replaceAll("/", "-")}`;
    return manual(
      "version-manager",
      npmTool ? "mise manages this installation." : "mise manages this installation. Update it with mise.",
      npmTool ? `mise upgrade npm:${packageName}` : null,
    );
  }
  if (paths.some((path) => path.includes("/.asdf/shims/") || path.includes("/.asdf/installs/"))) {
    return manual("version-manager", "asdf manages this installation. Update it with asdf.");
  }
  return null;
}

async function miseWrapperSource(context: InstallSourceContext): Promise<ProviderInstallSource | null> {
  if (context.platform === "win32") return null;
  const script = await context.readScript(context.real);
  return script?.startsWith("#!") && /\bmise\s+(?:x|exec)\b/u.test(script)
    ? manual("version-manager", "mise manages this installation. Update it with mise.")
    : null;
}

interface NpmLocation {
  prefix: string;
  binDirectory: string;
}

function npmLocation(context: InstallSourceContext, packageName: string): NpmLocation | null {
  const { path } = context;
  if (!path.isAbsolute(context.real)) return null;
  const marker = context.platform === "win32"
    ? `/node_modules/${packageName.toLocaleLowerCase("en-US")}/`
    : `/lib/node_modules/${packageName}/`;
  const comparable = context.key(context.real);
  const index = comparable.lastIndexOf(marker);
  if (index > 0) {
    const prefix = context.real.slice(0, index);
    if (context.key(prefix).includes("/node_modules/")) return null;
    const miseTool = /\/mise\/installs\/([^/]+)\/[^/]+$/u.exec(context.key(prefix))?.[1];
    if (miseTool && miseTool !== "node") return null;
    return {
      prefix,
      binDirectory: context.platform === "win32" ? prefix : path.join(prefix, "bin"),
    };
  }
  if (context.platform !== "win32") return null;
  const directory = path.dirname(context.hit);
  if (
    context.key(directory).endsWith("/appdata/roaming/npm")
    && context.commandNames().some((name) =>
      /\.(?:bat|cmd|exe)$/u.test(name)
      && context.same(path.basename(context.hit), name))
  ) {
    return { prefix: directory, binDirectory: directory };
  }
  return null;
}

async function npmInstallationProblem(
  context: InstallSourceContext,
  location: NpmLocation,
  packageName: string,
): Promise<"unverified" | "read-only" | null> {
  const { path } = context;
  const scopes = packageName.split("/");
  const directories = [
    location.prefix,
    path.join(location.prefix, "lib"),
    path.join(location.prefix, "lib", "node_modules"),
    ...scopes.map((_, index) =>
      path.join(location.prefix, "lib", "node_modules", ...scopes.slice(0, index + 1))),
    location.binDirectory,
  ];
  for (const directory of directories) {
    if (await context.resolved(directory) !== directory) return "unverified";
  }
  let linked = false;
  for (const name of context.commandNames()) {
    if (await context.resolved(path.join(location.binDirectory, name)) === context.real) {
      linked = true;
      break;
    }
  }
  if (!linked) return "unverified";
  return await context.writable(directories.slice(2)) ? null : "read-only";
}

async function npmRuntime(
  context: InstallSourceContext,
  manager: string,
): Promise<{ node: string; pathPrefix: string } | null> {
  const match = /^(.*)\/(?:lib\/node_modules|share\/nodejs)\/npm\/bin\/npm-cli\.js$/u.exec(manager);
  if (!match?.[1] || !posix.isAbsolute(manager)) return null;
  const pathPrefix = posix.join(match[1], "bin");
  const node = (await context.candidates(posix.join(pathPrefix, "node"), context.input.environment))[0];
  return node ? { node, pathPrefix } : null;
}

async function npmSource(
  context: InstallSourceContext,
  packageName: string,
): Promise<ProviderInstallSource | null> {
  const location = npmLocation(context, packageName);
  if (!location) return null;
  const windows = context.platform === "win32";
  const scripts = context.definition.allowScripts.map((name) => `--allow-scripts=${name}`);
  const displayPrefix = context.display(location.prefix);
  const manualCommand = windows
    ? ["npm", "install", "-g", ...scripts, context.spec()].join(" ")
    : displayPrefix
      ? ["npm", "install", "-g", "--prefix", displayPrefix, ...scripts, context.spec()].join(" ")
      : null;
  if (!windows) {
    const problem = await npmInstallationProblem(context, location, packageName);
    if (problem === "unverified") {
      return manual("npm-global", `Inertia could not verify the npm installation that owns this ${context.definition.label} CLI.`);
    }
    if (problem === "read-only") {
      return manual(
        "npm-global",
        "Your account cannot write this installation.",
        SUDO_PREFIXES.includes(location.prefix) && manualCommand ? `sudo ${manualCommand}` : null,
      );
    }
  }
  const owned = context.path.join(location.binDirectory, windows ? "npm.cmd" : "npm");
  const manager = (await context.candidates(owned, context.input.environment))[0]
    ?? (windows ? undefined : (await context.candidates("npm", context.input.environment))[0]);
  if (!manager) {
    return manual("npm-global", "Inertia could not find npm to update this CLI.", manualCommand);
  }
  const runtime = windows ? null : await npmRuntime(context, manager);
  if (!windows && !runtime) {
    return manual("npm-global", "Inertia could not pair npm with its Node executable.", manualCommand);
  }
  return update(context, "npm-global", {
    executable: runtime?.node ?? manager,
    args: [
      ...(runtime ? [manager] : []),
      "install",
      "-g",
      ...(windows ? [] : ["--prefix", location.prefix]),
      ...scripts,
      context.spec(),
    ],
    environmentPathPrefix: runtime?.pathPrefix ?? location.binDirectory,
    lockKey: `npm-global:${context.key(location.prefix)}`,
  }, "npm", manualCommand);
}

async function homebrewSource(context: InstallSourceContext): Promise<ProviderInstallSource | null> {
  const match = /^(.*)\/(cellar|caskroom)\/([^/]+)\/[^/]+\//iu.exec(context.real.replaceAll("\\", "/"));
  if (!match?.[1] || context.platform === "win32") return null;
  const prefix = match[1];
  const kind = match[2]!.toLowerCase() === "cellar" ? "formula" : "cask";
  const known = context.definition.homebrew.find((entry) =>
    entry.kind === kind && entry.name === match[3]);
  if (!known) {
    return manual("homebrew", "Homebrew installed this CLI under a name Inertia does not recognize. Update it with Homebrew.");
  }
  const args = kind === "cask" ? ["upgrade", "--cask", known.name] : ["upgrade", known.name];
  const manualCommand = ["brew", ...args].join(" ");
  const brew = posix.join(prefix, "bin", "brew");
  const brewTarget = await context.resolved(brew);
  if (
    !brewTarget
    || !await context.runnable(brew)
    || ![brew, posix.join(prefix, "Homebrew", "bin", "brew")].includes(brewTarget)
  ) {
    return manual("homebrew", "Inertia could not find the Homebrew that owns this installation.", manualCommand);
  }
  const homebrew = { brew, name: known.name, cask: kind === "cask" };
  if (!await context.writable([posix.join(prefix, match[2]!, known.name)])) {
    return {
      ...manual("homebrew", "Your account cannot write this Homebrew installation.", manualCommand),
      homebrew,
    };
  }
  return {
    ...update(context, "homebrew", {
      executable: brew,
      args,
      lockKey: `homebrew:${prefix}`,
      ...(context.input.providerId === "opencode"
        ? { versionPin: { major: 1, argumentIndex: null, command: null } }
        : {}),
    }, "Homebrew", manualCommand),
    homebrew,
  };
}

async function snapSource(context: InstallSourceContext): Promise<ProviderInstallSource | null> {
  if (context.platform !== "linux") return null;
  const real = /^\/snap\/([^/]+)\//u.exec(context.key(context.real))?.[1];
  let hit = /^\/snap\/bin\/([^/]+)$/u.exec(context.key(context.hit))?.[1];
  if (hit && (!real || real === "bin")) {
    const target = await context.readlink(context.hit).catch(() => null);
    const app = target ? posix.basename(target) : null;
    if (app && app !== "snap") hit = app;
  }
  const name = real && real !== "bin" ? real : hit?.split(".", 1)[0];
  if (!name) return null;
  return manual(
    "snap",
    "Snap manages this installation.",
    SNAP_NAME.test(name) ? `sudo snap refresh ${name}` : null,
  );
}

function systemSource(context: InstallSourceContext): ProviderInstallSource | null {
  if (context.platform === "win32") return null;
  const real = context.key(context.real);
  return SYSTEM_PACKAGE_ROOTS.some((root) => real.startsWith(root))
    ? manual("system-package", `Your system package manager installed ${context.definition.label}. Update it with that package manager.`)
    : null;
}

export async function classifyProviderInstallSource(
  input: ProviderInstallSourceInput,
  dependencies: ProviderInstallSourceDependencies = {},
): Promise<ProviderInstallSource> {
  const context = new InstallSourceContext(input, dependencies);
  await context.resolvePathHit();
  const native = nativeSource(context);
  if (native) return native;
  const packageName = context.definition.packageName;
  if (packageName) {
    for (const source of [bunSource, pnpmSource, yarnSource, voltaSource]) {
      const result = await source(context, packageName);
      if (result) return result;
    }
  }
  const uvTool = await uvToolSource(context);
  if (uvTool) return uvTool;
  const versionManager = versionManagerSource(context);
  if (versionManager) return versionManager;
  if (packageName) {
    const npm = await npmSource(context, packageName);
    if (npm) return npm;
  }
  const wrapped = await miseWrapperSource(context);
  if (wrapped) return wrapped;
  const homebrew = await homebrewSource(context);
  if (homebrew) return homebrew;
  const snap = await snapSource(context);
  if (snap) return snap;
  if (context.key(context.real).includes("/node_modules/")) {
    return manual("manual", `Inertia could not tell which package manager installed this ${context.definition.label} CLI. Update it the way you installed it.`);
  }
  return systemSource(context)
    ?? manual("manual", `Inertia could not tell how ${context.definition.label} was installed. Update it the way you installed it.`);
}

export function pinnedProviderUpdateAction(
  action: ProviderInstallUpdateAction,
  version: string | null,
): ProviderInstallUpdateAction | null {
  const pin = action.versionPin;
  if (!pin) return action;
  const match = version ? /^(\d+)\.\d+\.\d+$/u.exec(version) : null;
  if (!match || Number(match[1]) !== pin.major) return null;
  if (pin.argumentIndex === null) return action;
  return {
    ...action,
    args: [
      ...action.args.slice(0, pin.argumentIndex),
      version!,
      ...action.args.slice(pin.argumentIndex),
    ],
  };
}

export function pinnedManualCommand(
  manualCommand: string | null,
  action: ProviderInstallUpdateAction | null,
  version: string | null,
): string | null {
  const pin = action?.versionPin;
  if (!action || !pin) return manualCommand;
  const pinned = pinnedProviderUpdateAction(action, version);
  if (!pinned) return null;
  return pin.command ? [pin.command, ...pinned.args].join(" ") : manualCommand;
}
