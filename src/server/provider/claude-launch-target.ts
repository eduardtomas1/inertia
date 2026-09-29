import { readFileSync, realpathSync, statSync } from "node:fs";
import { win32 } from "node:path";

import { environmentValue } from "../environment";

const CLAUDE_CODE_PACKAGE = "@anthropic-ai/claude-code";
const MAX_PACKAGE_MANIFEST_BYTES = 256 * 1024;
const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const UNRESOLVED_SHIM_REASON =
  "Claude Code was found as a Windows command shim that Inertia cannot launch safely; reinstall it with npm or the native installer";
const MISSING_NODE_REASON =
  "Claude Code was found as an npm command shim, but no Node.js runtime was found to run it";

export interface ClaudeLaunchTarget {
  command: string;
  scriptPrefix: string[];
}

export type ClaudeLaunchResolution =
  | { ok: true; target: ClaudeLaunchTarget }
  | { ok: false; reason: string };

export interface ClaudeLaunchFileSystem {
  readFile(path: string): Buffer;
  realpath(path: string): string;
  fileSize(path: string): number | null;
}

export interface ClaudeLaunchTargetOptions {
  platform?: NodeJS.Platform;
  fileSystem?: ClaudeLaunchFileSystem;
  electronExecutable?: string;
}

const nodeFileSystem: ClaudeLaunchFileSystem = {
  readFile: (path) => readFileSync(path),
  realpath: (path) => realpathSync.native(path),
  fileSize: (path) => {
    try {
      const details = statSync(path);
      return details.isFile() ? details.size : null;
    } catch {
      return null;
    }
  },
};

export function isWindowsCommandShim(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32"
    && [".cmd", ".bat"].includes(win32.extname(executable).toLowerCase());
}

export function resolveClaudeLaunchTarget(
  executable: string,
  environment: NodeJS.ProcessEnv,
  options: ClaudeLaunchTargetOptions = {},
): ClaudeLaunchResolution {
  const platform = options.platform ?? process.platform;
  if (!isWindowsCommandShim(executable, platform)) {
    return { ok: true, target: { command: executable, scriptPrefix: [] } };
  }
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  try {
    const entry = packageEntry(executable, fileSystem);
    if (!entry) return { ok: false, reason: UNRESOLVED_SHIM_REASON };
    const extension = win32.extname(entry).toLowerCase();
    if (extension === ".exe") {
      return { ok: true, target: { command: entry, scriptPrefix: [] } };
    }
    if (!SCRIPT_EXTENSIONS.has(extension)) {
      return { ok: false, reason: UNRESOLVED_SHIM_REASON };
    }
    const node = nodeRuntime(
      executable,
      environment,
      fileSystem,
      options.electronExecutable
        ?? (process.versions.electron ? process.execPath : undefined),
    );
    if (!node) return { ok: false, reason: MISSING_NODE_REASON };
    return { ok: true, target: { command: node, scriptPrefix: [entry] } };
  } catch {
    return { ok: false, reason: UNRESOLVED_SHIM_REASON };
  }
}

function packageEntry(
  shim: string,
  fileSystem: ClaudeLaunchFileSystem,
): string | null {
  const shimName = win32.basename(shim, win32.extname(shim)).toLowerCase();
  const packageDirectory = win32.join(
    win32.dirname(shim),
    "node_modules",
    "@anthropic-ai",
    "claude-code",
  );
  const manifestPath = win32.join(packageDirectory, "package.json");
  const size = fileSystem.fileSize(manifestPath);
  if (size === null || size > MAX_PACKAGE_MANIFEST_BYTES) return null;
  const manifest: unknown = JSON.parse(fileSystem.readFile(manifestPath).toString("utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return null;
  const { name, bin } = manifest as { name?: unknown; bin?: unknown };
  if (name !== CLAUDE_CODE_PACKAGE) return null;
  const relativeEntry = typeof bin === "string"
    ? shimName === "claude-code" ? bin : null
    : bin && typeof bin === "object" && !Array.isArray(bin)
      ? Object.entries(bin).find(([command]) => command.toLowerCase() === shimName)?.[1]
      : null;
  if (
    typeof relativeEntry !== "string"
    || !relativeEntry.trim()
    || relativeEntry.includes("\0")
    || win32.isAbsolute(relativeEntry)
  ) return null;
  const realPackage = fileSystem.realpath(packageDirectory);
  const realEntry = fileSystem.realpath(win32.resolve(packageDirectory, relativeEntry));
  if (!contains(realPackage, realEntry)) return null;
  if (fileSystem.fileSize(realEntry) === null) return null;
  return realEntry;
}

function nodeRuntime(
  shim: string,
  environment: NodeJS.ProcessEnv,
  fileSystem: ClaudeLaunchFileSystem,
  electronExecutable: string | undefined,
): string | null {
  const pathEntries = (environmentValue(environment, "PATH", "win32") ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry && win32.isAbsolute(entry) && !entry.includes("\0"));
  const electron = electronExecutable
    ? safeRealpath(electronExecutable, fileSystem)?.toLowerCase()
    : undefined;
  for (const directory of [win32.dirname(shim), ...pathEntries]) {
    const candidate = win32.join(directory, "node.exe");
    if (fileSystem.fileSize(candidate) === null) continue;
    const real = safeRealpath(candidate, fileSystem);
    if (!real || real.toLowerCase() === electron) continue;
    if (win32.basename(real).toLowerCase() !== "node.exe") continue;
    return real;
  }
  return null;
}

function safeRealpath(
  path: string,
  fileSystem: ClaudeLaunchFileSystem,
): string | null {
  try {
    return fileSystem.realpath(path);
  } catch {
    return null;
  }
}

function contains(root: string, candidate: string): boolean {
  const normalizedRoot = win32.normalize(root).replace(/\\+$/u, "").toLowerCase();
  const normalizedCandidate = win32.normalize(candidate).toLowerCase();
  return normalizedCandidate.startsWith(`${normalizedRoot}\\`);
}
