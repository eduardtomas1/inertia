import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import { buildWindowsCommandShimInvocation } from "../node/windows-command-shim";
import { withoutWindowsCurrentDirectorySearch, withUserWindowsCurrentDirectorySearch } from "../node/windows-current-directory-search";
import {
  buildEditorArguments,
  EDITORS,
  editorById,
  validateEditorPosition,
  type DetectedEditor,
  type EditorDefinition,
  type EditorId,
  type EditorPlatformOs,
} from "../shared/editors";
import {
  hasWindowsShortNameComponent,
  hasWindowsStreamOrDeviceSpelling,
} from "./project-path-open";
import { runtimeProcessEnvironment } from "./runtime-process-environment";
import { forceKillRuntimeProcessTree } from "./runtime-process-tree";

const DEFAULT_CACHE_TTL_MS = 60_000;
const VERSION_PROBE_TIMEOUT_MS = 2_000;
const VERSION_PROBE_MAX_BYTES = 4_096;

export interface EditorFileStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface EditorVersionProbeResult {
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
}

export interface EditorSpawnRequest {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  detached: boolean;
  stdio: "ignore";
  shell: false;
  windowsVerbatimArguments?: boolean;
  windowsHide?: boolean;
}

export interface EditorLauncherDependencies {
  platform?: NodeJS.Platform;
  env?: () => NodeJS.ProcessEnv;
  homeDir?: () => string;
  lstat?: (filePath: string) => Promise<EditorFileStats | null>;
  stat?: (filePath: string) => Promise<EditorFileStats | null>;
  accessExecutable?: (filePath: string) => Promise<boolean>;
  readdir?: (directoryPath: string) => Promise<string[]>;
  realpath?: (filePath: string) => Promise<string>;
  probeVersion?: (
    executable: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
  ) => Promise<EditorVersionProbeResult>;
  spawnProcess?: (request: EditorSpawnRequest) => Promise<void>;
  now?: () => number;
  cacheTtlMs?: number;
}

export interface ResolvedEditorExecutable {
  readonly command: string;
  readonly baseArgs: readonly string[];
}

export interface LaunchEditorOptions {
  readonly editor: EditorId;
  readonly targetPath: string;
  readonly authorizedRoot: string;
  readonly projectRoot?: string;
  readonly line?: number;
  readonly column?: number;
  readonly literalPath?: boolean;
}

interface NormalizedDeps {
  platform: NodeJS.Platform;
  env: () => NodeJS.ProcessEnv;
  homeDir: () => string;
  lstat: (filePath: string) => Promise<EditorFileStats | null>;
  stat: (filePath: string) => Promise<EditorFileStats | null>;
  accessExecutable: (filePath: string) => Promise<boolean>;
  readdir: (directoryPath: string) => Promise<string[]>;
  realpath: (filePath: string) => Promise<string>;
  probeVersion: (
    executable: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
  ) => Promise<EditorVersionProbeResult>;
  spawnProcess: (request: EditorSpawnRequest) => Promise<void>;
  now: () => number;
  cacheTtlMs: number;
}

function pathApi(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

function platformOs(platform: NodeJS.Platform): EditorPlatformOs {
  if (platform === "darwin" || platform === "win32") return platform;
  return "linux";
}

function envValue(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return env[key];
  const upper = key.toUpperCase();
  const matched = Object.keys(env).find((candidate) => candidate.toUpperCase() === upper);
  return matched ? env[matched] : undefined;
}

function windowsPathExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = envValue(env, "PATHEXT", "win32") ?? ".COM;.EXE;.BAT;.CMD";
  const parsed = raw
    .split(";")
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry.startsWith(".") && entry.length > 1);
  return parsed.length > 0 ? [...new Set(parsed)] : [".COM", ".EXE", ".BAT", ".CMD"];
}

function isPrereleaseZedPath(filePath: string): boolean {
  const segments = filePath.split(/[\\/]/u).slice(0, -1);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!.toLowerCase();
    if (segment.includes("zed")) {
      return segment.includes("nightly") || segment.includes("preview");
    }
  }
  return false;
}

function isVersionedMacBundle(entry: string, appName: string): boolean {
  if (!entry.startsWith(`${appName} `) || !entry.endsWith(".app")) return false;
  return /^\d[\d.]*$/u.test(entry.slice(appName.length + 1, -".app".length));
}

function isContainedPath(
  root: string,
  target: string,
  platform: NodeJS.Platform,
): boolean {
  const api = pathApi(platform);
  const normalizedRoot = platform === "win32" ? root.toLocaleLowerCase("en-US") : root;
  const normalizedTarget = platform === "win32" ? target.toLocaleLowerCase("en-US") : target;
  const rel = api.relative(normalizedRoot, normalizedTarget);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel));
}

function expandTemplatePath(
  template: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string | undefined,
): string | null {
  const api = pathApi(platform);
  const dataHome = envValue(env, "XDG_DATA_HOME", platform)
    || (home ? api.join(home, ".local", "share") : undefined);
  const variables: Record<string, string | undefined> = {
    $HOME: home,
    $LOCALAPPDATA: envValue(env, "LOCALAPPDATA", platform),
    $PROGRAMFILES: envValue(env, "ProgramFiles", platform),
    $PROGRAMFILES_X86: envValue(env, "ProgramFiles(x86)", platform),
    $PROGRAMW6432: envValue(env, "ProgramW6432", platform),
    $XDG_DATA_HOME: dataHome,
  };
  let expanded = template;
  for (const [token, value] of Object.entries(variables)) {
    if (!expanded.includes(token)) continue;
    if (!value) return null;
    expanded = expanded.replaceAll(token, value);
  }
  return platform === "win32" ? expanded.replaceAll("/", "\\") : expanded;
}

async function defaultLstat(filePath: string): Promise<EditorFileStats | null> {
  try {
    return await lstat(filePath);
  } catch {
    return null;
  }
}

async function defaultStat(filePath: string): Promise<EditorFileStats | null> {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

async function defaultAccessExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultReaddir(directoryPath: string): Promise<string[]> {
  try {
    return await readdir(directoryPath);
  } catch {
    return [];
  }
}

export function sanitizeEditorEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const sanitized = runtimeProcessEnvironment(source, platform);
  for (const key of Object.keys(sanitized)) {
    if (key.toUpperCase() === "ELECTRON_RUN_AS_NODE") {
      delete sanitized[key];
    }
  }
  return withoutWindowsCurrentDirectorySearch(sanitized, platform);
}

const EDITOR_WITHHELD_ENVIRONMENT_KEYS = new Set([
  "NODE_OPTIONS",
  "NODE_CHANNEL_FD",
  "NODE_CHANNEL_SERIALIZATION_MODE",
  "NODE_UNIQUE_ID",
]);

export function editorLaunchEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toUpperCase();
    if (
      value === undefined
      || normalized.startsWith("ELECTRON_")
      || normalized.startsWith("INERTIA_")
      || EDITOR_WITHHELD_ENVIRONMENT_KEYS.has(normalized)
    ) continue;
    environment[key] = value;
  }
  return withUserWindowsCurrentDirectorySearch(environment, platform);
}

async function defaultProbeVersion(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<EditorVersionProbeResult> {
  return await new Promise<EditorVersionProbeResult>((resolveProbe) => {
    const sanitized = sanitizeEditorEnvironment(env, platform);
    let child: ChildProcess;
    try {
      const invocation = buildWindowsCommandShimInvocation(executable, args, sanitized, platform);
      child = spawn(invocation.command, invocation.args, {
        env: sanitized,
        detached: platform !== "win32",
        shell: false,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolveProbe({ exitCode: null, stdout: "", timedOut: false });
      return;
    }
    let settled = false;
    let stdout = "";
    const finish = (exitCode: number | null, timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProbe({ exitCode, stdout, timedOut });
    };
    const timer = setTimeout(() => {
      if (typeof child.pid === "number" && child.pid > 1) {
        void forceKillRuntimeProcessTree(child.pid, {
          platform,
          environment: sanitized,
          rootProcessGroup: platform !== "win32",
        }).catch(() => undefined);
      } else {
        try {
          child.kill();
        } catch {
          void 0;
        }
      }
      finish(null, true);
    }, VERSION_PROBE_TIMEOUT_MS);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < VERSION_PROBE_MAX_BYTES) {
        stdout += chunk.toString("utf8").slice(0, VERSION_PROBE_MAX_BYTES - stdout.length);
      }
    });
    child.once("error", () => finish(null, false));
    child.once("close", (code) => finish(code, false));
  });
}

async function defaultSpawnProcess(request: EditorSpawnRequest): Promise<void> {
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    let child: ChildProcess;
    try {
      child = spawn(request.command, [...request.args], {
        env: request.env,
        detached: request.detached,
        stdio: request.stdio,
        shell: false,
        windowsVerbatimArguments: request.windowsVerbatimArguments,
        windowsHide: request.windowsHide,
      });
    } catch (error) {
      rejectSpawn(error);
      return;
    }
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      rejectSpawn(error);
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolveSpawn();
    });
  });
}

function normalizeDeps(deps: EditorLauncherDependencies = {}): NormalizedDeps {
  return {
    platform: deps.platform ?? process.platform,
    env: deps.env ?? (() => process.env),
    homeDir: deps.homeDir ?? (() => homedir()),
    lstat: deps.lstat ?? defaultLstat,
    stat: deps.stat ?? defaultStat,
    accessExecutable: deps.accessExecutable ?? defaultAccessExecutable,
    readdir: deps.readdir ?? defaultReaddir,
    realpath: deps.realpath ?? ((filePath) => realpath(filePath)),
    probeVersion: deps.probeVersion ?? defaultProbeVersion,
    spawnProcess: deps.spawnProcess ?? defaultSpawnProcess,
    now: deps.now ?? (() => Date.now()),
    cacheTtlMs: deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
  };
}

async function isExecutableFile(
  candidate: string,
  env: NodeJS.ProcessEnv,
  deps: NormalizedDeps,
): Promise<boolean> {
  const info = await deps.stat(candidate);
  if (!info || !info.isFile()) return false;
  if (deps.platform === "win32") {
    const ext = win32.extname(candidate).toUpperCase();
    return ext.length > 0 && windowsPathExtensions(env).includes(ext);
  }
  return await deps.accessExecutable(candidate);
}

function commandNamesForPlatform(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  if (platform !== "win32") return [command];
  if (win32.extname(command)) return [command];
  return windowsPathExtensions(env).map((ext) => `${command}${ext.toLowerCase()}`);
}

async function resolveCommandOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
  deps: NormalizedDeps,
  limit = Number.POSITIVE_INFINITY,
): Promise<string[]> {
  const api = pathApi(deps.platform);
  const pathValue = envValue(env, "PATH", deps.platform) ?? "";
  if (!pathValue) return [];
  const separator = deps.platform === "win32" ? ";" : ":";
  const entries = pathValue.split(separator);
  const names = commandNamesForPlatform(command, env, deps.platform);
  const results: string[] = [];
  const seen = new Set<string>();

  for (const rawEntry of entries) {
    const trimmed = rawEntry.trim().replace(/^"(.*)"$/u, "$1");
    if (!trimmed || !api.isAbsolute(trimmed)) continue;
    for (const name of names) {
      const candidate = api.join(trimmed, name);
      const key = deps.platform === "win32" ? candidate.toLocaleLowerCase("en-US") : candidate;
      if (seen.has(key)) continue;
      if (await isExecutableFile(candidate, env, deps)) {
        seen.add(key);
        results.push(candidate);
        if (results.length >= limit) return results;
      }
    }
  }
  return results;
}

async function resolveDirectPath(
  candidate: string,
  env: NodeJS.ProcessEnv,
  deps: NormalizedDeps,
): Promise<string | null> {
  for (const name of commandNamesForPlatform(candidate, env, deps.platform)) {
    if (await isExecutableFile(name, env, deps)) return name;
  }
  return null;
}

async function wellKnownCandidates(
  editor: EditorDefinition,
  env: NodeJS.ProcessEnv,
  deps: NormalizedDeps,
): Promise<string[]> {
  const os = platformOs(deps.platform);
  const api = pathApi(deps.platform);
  const home = envValue(env, "HOME", deps.platform)
    ?? (deps.platform === "win32" ? envValue(env, "USERPROFILE", deps.platform) : undefined)
    ?? deps.homeDir();
  const candidates: string[] = [];
  const primaryCommand = editor.commands[os][0];

  for (const template of editor.installPaths[os]) {
    const expanded = expandTemplatePath(template, env, deps.platform, home);
    if (expanded) candidates.push(expanded);
  }

  let toolbox: { dir: string; suffix: string } | undefined;

  if (os === "darwin") {
    const appRoots = ["/Applications", ...(home ? [posix.join(home, "Applications")] : [])];
    for (const root of appRoots) {
      const entries = await deps.readdir(root);
      for (const entry of entries) {
        const matched = editor.macAppNames.some(
          (name) => entry === `${name}.app` || isVersionedMacBundle(entry, name),
        );
        if (!matched) continue;
        const contents = posix.join(root, entry, "Contents");
        if (editor.jetbrains || editor.id === "zed") {
          candidates.push(posix.join(contents, "MacOS", editor.id === "zed" ? "cli" : primaryCommand));
        } else {
          candidates.push(
            posix.join(contents, "Resources", "app", "bin", primaryCommand),
            posix.join(contents, "Resources", "app", "bin", "code"),
          );
        }
      }
    }
    if (home && editor.jetbrains) {
      toolbox = {
        dir: posix.join(home, "Library", "Application Support", "JetBrains", "Toolbox", "scripts"),
        suffix: "",
      };
    }
  } else if (os === "win32") {
    const localAppData = envValue(env, "LOCALAPPDATA", deps.platform);
    const roots = [
      ...(localAppData ? [win32.join(localAppData, "Programs")] : []),
      ...[
        envValue(env, "ProgramFiles", deps.platform),
        envValue(env, "ProgramFiles(x86)", deps.platform),
        envValue(env, "ProgramW6432", deps.platform),
      ].filter((root): root is string => Boolean(root)),
    ];
    if (editor.jetbrains) {
      if (localAppData) {
        toolbox = {
          dir: win32.join(localAppData, "JetBrains", "Toolbox", "scripts"),
          suffix: ".cmd",
        };
      }
      for (const baseRoot of roots) {
        for (const directory of [baseRoot, win32.join(baseRoot, "JetBrains")]) {
          const entries = await deps.readdir(directory);
          for (const entry of entries) {
            if (editor.windowsInstallNames.some((name) => entry === name || entry.startsWith(`${name} `))) {
              candidates.push(
                win32.join(directory, entry, "bin", `${primaryCommand}64.exe`),
                win32.join(directory, entry, "bin", `${primaryCommand}.exe`),
              );
            }
          }
        }
      }
    }
  } else if (os === "linux") {
    const dataHome = envValue(env, "XDG_DATA_HOME", deps.platform)
      || (home ? posix.join(home, ".local", "share") : undefined);
    if (editor.jetbrains && dataHome) {
      toolbox = {
        dir: posix.join(dataHome, "JetBrains", "Toolbox", "scripts"),
        suffix: "",
      };
    }
  }

  if (toolbox) {
    const entries = await deps.readdir(toolbox.dir);
    const numbered = entries
      .filter((entry) => (
        entry.startsWith(primaryCommand)
        && entry.endsWith(toolbox.suffix)
        && /^\d+$/u.test(entry.slice(primaryCommand.length, entry.length - toolbox.suffix.length))
      ))
      .sort((left, right) => left.length - right.length || left.localeCompare(right, "en"));
    for (const entry of numbered) {
      candidates.push(api.join(toolbox.dir, entry));
    }
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = deps.platform === "win32" ? candidate.toLocaleLowerCase("en-US") : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

async function verifyProbedExecutable(
  executable: string,
  isZed: boolean,
  env: NodeJS.ProcessEnv,
  deps: NormalizedDeps,
): Promise<boolean> {
  const probe = await deps.probeVersion(executable, ["--version"], env, deps.platform);
  if (probe.timedOut) return !isZed;
  if (probe.exitCode !== 0) return false;
  return !isZed || probe.stdout.trimStart().startsWith("Zed");
}

function baseArgsForSource(
  editor: EditorDefinition,
  os: EditorPlatformOs,
  fromBundle: boolean,
): readonly string[] {
  if (fromBundle && editor.bundleBaseArgs?.[os] !== undefined) {
    return editor.bundleBaseArgs[os]!;
  }
  return editor.baseArgs ?? [];
}

export async function resolveEditorExecutable(
  editor: EditorDefinition,
  rawDeps: EditorLauncherDependencies = {},
): Promise<ResolvedEditorExecutable | null> {
  const deps = normalizeDeps(rawDeps);
  const env = deps.env();
  const os = platformOs(deps.platform);
  const commands = editor.commands[os];
  const probeCursor = editor.id === "cursor";
  const probeZed = editor.id === "zed" && os !== "win32";
  const preferBundle = os === "darwin" && editor.id === "zed";
  const rejected = new Set<string>();

  const accept = async (
    candidate: string,
    fromBundle: boolean,
    mustProbe: boolean,
  ): Promise<ResolvedEditorExecutable | null> => {
    const key = deps.platform === "win32" ? candidate.toLocaleLowerCase("en-US") : candidate;
    if (rejected.has(key)) return null;
    if (mustProbe && !(await verifyProbedExecutable(candidate, probeZed, env, deps))) {
      rejected.add(key);
      return null;
    }
    return { command: candidate, baseArgs: baseArgsForSource(editor, os, fromBundle) };
  };

  if (os === "win32" && editor.id === "zed") {
    let prereleaseFallback: string | null = null;
    for (const command of commands) {
      const matches = await resolveCommandOnPath(command, env, deps);
      for (const match of matches) {
        if (!isPrereleaseZedPath(match)) {
          return { command: match, baseArgs: baseArgsForSource(editor, os, false) };
        }
        prereleaseFallback ??= match;
      }
    }
    if (prereleaseFallback) {
      return { command: prereleaseFallback, baseArgs: baseArgsForSource(editor, os, false) };
    }
  } else if (!preferBundle) {
    for (const command of commands) {
      const mustProbe = probeCursor || (probeZed && command === "zed");
      const matches = await resolveCommandOnPath(command, env, deps, mustProbe ? Number.POSITIVE_INFINITY : 1);
      for (const match of matches) {
        const resolved = await accept(match, false, mustProbe);
        if (resolved) return resolved;
      }
    }
  }

  const known = await wellKnownCandidates(editor, env, deps);
  for (const candidate of known) {
    const resolvedPath = await resolveDirectPath(candidate, env, deps);
    if (!resolvedPath) continue;
    const base = pathApi(deps.platform).basename(resolvedPath).toLowerCase();
    const mustProbe = probeCursor || (probeZed && base === "zed");
    const resolved = await accept(resolvedPath, true, mustProbe);
    if (resolved) return resolved;
  }

  if (preferBundle) {
    for (const command of commands) {
      const matches = await resolveCommandOnPath(command, env, deps);
      for (const match of matches) {
        const resolved = await accept(match, false, true);
        if (resolved) return resolved;
      }
    }
  }

  return null;
}

export class EditorLauncher {
  private readonly deps: NormalizedDeps;
  private cached: { expiresAt: number; editors: DetectedEditor[] } | null = null;
  private inFlight: Promise<DetectedEditor[]> | null = null;

  constructor(deps: EditorLauncherDependencies = {}) {
    this.deps = normalizeDeps(deps);
  }

  invalidateCache(): void {
    this.cached = null;
  }

  async detectAvailableEditors(options: { refresh?: boolean } = {}): Promise<DetectedEditor[]> {
    const now = this.deps.now();
    if (!options.refresh && this.cached && now < this.cached.expiresAt) {
      return [...this.cached.editors];
    }
    if (options.refresh) {
      this.cached = null;
    } else if (this.inFlight) {
      return [...(await this.inFlight)];
    }

    const scan = (async (): Promise<DetectedEditor[]> => {
      const results = await Promise.all(
        EDITORS.map(async (editor) => {
          const resolved = await resolveEditorExecutable(editor, this.deps);
          return resolved ? { id: editor.id, label: editor.label } : null;
        }),
      );
      const detected = results.filter((entry): entry is DetectedEditor => entry !== null);
      this.cached = {
        expiresAt: this.deps.now() + this.deps.cacheTtlMs,
        editors: detected,
      };
      return detected;
    })();

    this.inFlight = scan;
    try {
      return [...(await scan)];
    } finally {
      if (this.inFlight === scan) {
        this.inFlight = null;
      }
    }
  }

  async launchEditor(options: LaunchEditorOptions): Promise<void> {
    const editor = editorById(options.editor);
    if (!editor) {
      throw new Error(`Unknown editor: ${options.editor}`);
    }
    const position = validateEditorPosition({
      ...(options.line !== undefined ? { line: options.line } : {}),
      ...(options.column !== undefined ? { column: options.column } : {}),
    });
    if (!position.ok) {
      throw new Error(position.error);
    }

    const api = pathApi(this.deps.platform);
    if (!options.targetPath || !api.isAbsolute(options.targetPath)) {
      throw new Error("Editor target path must be an absolute path.");
    }
    if (!options.authorizedRoot || !api.isAbsolute(options.authorizedRoot)) {
      throw new Error("Editor launch requires an authorized project root.");
    }
    if (
      this.deps.platform === "win32"
      && (
        hasWindowsStreamOrDeviceSpelling(options.targetPath)
        || hasWindowsShortNameComponent(options.targetPath)
      )
    ) {
      throw new Error("The target path cannot be opened in an editor.");
    }

    const metadata = await this.deps.lstat(options.targetPath);
    if (!metadata || metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
      throw new Error("The target path cannot be inspected or is not a regular file or folder.");
    }

    const [canonicalRoot, canonicalTarget] = await Promise.all([
      this.deps.realpath(options.authorizedRoot).catch(() => null),
      this.deps.realpath(options.targetPath).catch(() => null),
    ]);
    if (!canonicalRoot || !canonicalTarget) {
      throw new Error("The target path could not be resolved.");
    }
    if (
      this.deps.platform === "win32"
      && (
        hasWindowsStreamOrDeviceSpelling(canonicalTarget)
        || hasWindowsShortNameComponent(canonicalTarget)
      )
    ) {
      throw new Error("The target path cannot be opened in an editor.");
    }
    if (!isContainedPath(canonicalRoot, canonicalTarget, this.deps.platform)) {
      throw new Error("The target path is outside the authorized project.");
    }

    let literalPath = options.literalPath === true;
    if (editor.id === "zed" && position.line !== undefined && !literalPath && !metadata.isDirectory()) {
      const suffixed = position.column !== undefined
        ? `${canonicalTarget}:${position.line}:${position.column}`
        : `${canonicalTarget}:${position.line}`;
      if ((await this.deps.stat(suffixed)) !== null) {
        literalPath = true;
      }
    }

    const resolved = await resolveEditorExecutable(editor, this.deps);
    if (!resolved) {
      throw new Error(`${editor.label} is not installed.`);
    }

    let canonicalProjectRoot = canonicalRoot;
    if (options.projectRoot) {
      if (!api.isAbsolute(options.projectRoot)) {
        throw new Error("The project root path must be absolute.");
      }
      const resolvedProjectRoot = await this.deps.realpath(options.projectRoot).catch(() => null);
      if (!resolvedProjectRoot || !isContainedPath(resolvedProjectRoot, canonicalTarget, this.deps.platform)) {
        throw new Error("The target path is outside the project root.");
      }
      canonicalProjectRoot = resolvedProjectRoot;
    }

    const args = buildEditorArguments(editor, {
      target: canonicalTarget,
      isDirectory: metadata.isDirectory(),
      projectRoot: canonicalProjectRoot,
      ...(position.line !== undefined ? { line: position.line } : {}),
      ...(position.column !== undefined ? { column: position.column } : {}),
      baseArgs: resolved.baseArgs,
      literalPath,
    });

    const launchEnv = editorLaunchEnvironment(this.deps.env(), this.deps.platform);
    const invocation = buildWindowsCommandShimInvocation(
      resolved.command,
      args,
      launchEnv,
      this.deps.platform,
      {
        guardCurrentDirectorySearch: false,
        unsafeErrorMessage: `${editor.label} cannot open a path containing control characters or double quotes.`,
      },
    );

    await this.deps.spawnProcess({
      command: invocation.command,
      args: invocation.args,
      env: launchEnv,
      detached: true,
      stdio: "ignore",
      shell: false,
      ...(invocation.windowsVerbatimArguments
        ? { windowsVerbatimArguments: true, windowsHide: true }
        : {}),
    });
  }
}
