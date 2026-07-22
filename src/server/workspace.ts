import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_PATH_LENGTH = 4_096;
const DEFAULT_LIST_LIMIT = 500;
const MAX_LIST_LIMIT = 1_000;
const DEFAULT_SEARCH_RESULTS = 100;
const MAX_SEARCH_RESULTS = 250;
const DEFAULT_SEARCH_DEPTH = 12;
const MAX_SEARCH_DEPTH = 24;
const DEFAULT_VISITED_ENTRIES = 20_000;
const MAX_VISITED_ENTRIES = 50_000;
const DEFAULT_TEXT_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const PACKAGE_JSON_BYTES = 256 * 1024;

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".cache",
  "node_modules",
  "bower_components",
  "coverage",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
]);

export type WorkspaceErrorCode =
  | "invalid-input"
  | "not-found"
  | "outside-workspace"
  | "unsafe-link"
  | "not-directory"
  | "not-file"
  | "file-too-large"
  | "not-text"
  | "invalid-package"
  | "operation-failed";

/** An error whose message is safe to display to an untrusted renderer. */
export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string) {
    super(message.slice(0, 240));
    this.name = "WorkspaceError";
    this.code = code;
  }
}

export type WorkspaceEntryKind = "file" | "directory" | "symlink" | "other";

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: WorkspaceEntryKind;
  size: number | null;
  modifiedAt: string | null;
  hidden: boolean;
}

export interface WorkspaceEntryList {
  directory: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}

export interface ListWorkspaceOptions {
  includeHidden?: boolean;
  maxEntries?: number;
}

export interface SearchWorkspaceOptions {
  includeHidden?: boolean;
  maxResults?: number;
  maxDepth?: number;
  maxVisitedEntries?: number;
  ignoredDirectories?: readonly string[];
}

export interface WorkspaceSearchResult {
  entries: WorkspaceEntry[];
  visitedEntries: number;
  truncated: boolean;
}

export interface ReadTextOptions {
  maxBytes?: number;
}

export interface WorkspaceTextFile {
  path: string;
  content: string;
  size: number;
  modifiedAt: string;
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export interface PackageScript {
  name: string;
  command: string;
}

export interface PackageScripts {
  packageJsonPath: string;
  packageManager: PackageManager;
  scripts: PackageScript[];
  scriptMap: Readonly<Record<string, string>>;
}

export interface PreviewScript extends PackageScript {
  confidence: "high" | "medium" | "low";
  reason: string;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WorkspaceError("invalid-input", "The requested limit is invalid.");
  }
  return Math.min(value, maximum);
}

function slashPath(path: string): string {
  return path.split(sep).join("/");
}

function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function validateRelativePath(path: string, allowRoot: boolean): string {
  if (
    typeof path !== "string" ||
    path.length > MAX_PATH_LENGTH ||
    path.includes("\0") ||
    /[\r\n]/u.test(path) ||
    isAbsolute(path)
  ) {
    throw new WorkspaceError("invalid-input", "The workspace path is invalid.");
  }
  const normalized = path === "" ? "." : path;
  if (!allowRoot && normalized === ".") throw new WorkspaceError("invalid-input", "Select a file inside the workspace.");
  return normalized;
}

async function workspaceRoot(workspacePath: string): Promise<string> {
  if (
    typeof workspacePath !== "string" ||
    workspacePath.length === 0 ||
    workspacePath.length > MAX_PATH_LENGTH ||
    workspacePath.includes("\0")
  ) {
    throw new WorkspaceError("invalid-input", "The workspace path is invalid.");
  }
  try {
    const root = await realpath(resolve(workspacePath));
    if (!(await stat(root)).isDirectory()) throw new WorkspaceError("not-directory", "The workspace is not a directory.");
    return root;
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError("not-found", "The workspace folder could not be found.");
  }
}

async function secureExistingPath(
  root: string,
  relativePath: string,
  expected: "file" | "directory",
): Promise<{ absolute: string; relativePath: string }> {
  const normalized = validateRelativePath(relativePath, expected === "directory");
  const absolute = resolve(root, normalized);
  if (!isContained(root, absolute) || (expected === "file" && absolute === root)) {
    throw new WorkspaceError("outside-workspace", "The requested path is outside the workspace.");
  }

  const segments = relative(root, absolute).split(sep).filter(Boolean);
  let cursor = root;
  try {
    for (const segment of segments) {
      cursor = resolve(cursor, segment);
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        throw new WorkspaceError("unsafe-link", "Symbolic links cannot be opened through the workspace browser.");
      }
    }
    const canonical = await realpath(absolute);
    if (!isContained(root, canonical)) {
      throw new WorkspaceError("outside-workspace", "The requested path resolves outside the workspace.");
    }
    const info = await stat(canonical);
    if (expected === "file" && !info.isFile()) throw new WorkspaceError("not-file", "The requested path is not a file.");
    if (expected === "directory" && !info.isDirectory()) {
      throw new WorkspaceError("not-directory", "The requested path is not a directory.");
    }
    return { absolute: canonical, relativePath: slashPath(relative(root, canonical)) || "." };
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError("not-found", "The requested workspace entry could not be found.");
  }
}

function entryKind(info: Awaited<ReturnType<typeof lstat>>): WorkspaceEntryKind {
  if (info.isSymbolicLink()) return "symlink";
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return "other";
}

async function describeEntry(root: string, absolute: string, name: string): Promise<WorkspaceEntry> {
  const info = await lstat(absolute);
  const kind = entryKind(info);
  return {
    name,
    path: slashPath(relative(root, absolute)),
    kind,
    size: kind === "file" ? info.size : null,
    modifiedAt: Number.isFinite(info.mtimeMs) ? info.mtime.toISOString() : null,
    hidden: name.startsWith("."),
  };
}

function compareEntries(left: WorkspaceEntry, right: WorkspaceEntry): number {
  if (left.kind === "directory" && right.kind !== "directory") return -1;
  if (left.kind !== "directory" && right.kind === "directory") return 1;
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

export async function listWorkspaceEntries(
  workspacePath: string,
  directory = "",
  options: ListWorkspaceOptions = {},
): Promise<WorkspaceEntryList> {
  const root = await workspaceRoot(workspacePath);
  const target = await secureExistingPath(root, directory, "directory");
  const maxEntries = boundedInteger(options.maxEntries, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  try {
    const entries: WorkspaceEntry[] = [];
    let truncated = false;
    const directoryHandle = await opendir(target.absolute);
    for await (const child of directoryHandle) {
      if (!options.includeHidden && child.name.startsWith(".")) continue;
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      entries.push(await describeEntry(root, resolve(target.absolute, child.name), child.name));
    }
    entries.sort(compareEntries);
    return { directory: target.relativePath === "." ? "" : target.relativePath, entries, truncated };
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError("operation-failed", "Unable to list this workspace folder.");
  }
}

interface SearchQueueEntry {
  absolute: string;
  depth: number;
}

export async function searchWorkspaceEntries(
  workspacePath: string,
  query: string,
  options: SearchWorkspaceOptions = {},
): Promise<WorkspaceSearchResult> {
  if (typeof query !== "string" || query.trim().length === 0 || query.length > 200 || /[\0\r\n]/u.test(query)) {
    throw new WorkspaceError("invalid-input", "Enter a search term between 1 and 200 characters.");
  }
  const root = await workspaceRoot(workspacePath);
  const maxResults = boundedInteger(options.maxResults, DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
  const maxDepth = boundedInteger(options.maxDepth, DEFAULT_SEARCH_DEPTH, MAX_SEARCH_DEPTH);
  const maxVisited = boundedInteger(options.maxVisitedEntries, DEFAULT_VISITED_ENTRIES, MAX_VISITED_ENTRIES);
  const ignored = new Set(options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES);
  const needle = query.trim().toLocaleLowerCase();
  const queue: SearchQueueEntry[] = [{ absolute: root, depth: 0 }];
  const entries: WorkspaceEntry[] = [];
  let visitedEntries = 0;
  let truncated = false;

  try {
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const directory = queue[queueIndex];
      const directoryHandle = await opendir(directory.absolute);
      for await (const child of directoryHandle) {
        if (visitedEntries >= maxVisited || entries.length >= maxResults) {
          truncated = true;
          break;
        }
        visitedEntries += 1;
        const hidden = child.name.startsWith(".");
        if (hidden && !options.includeHidden) continue;
        const absolute = resolve(directory.absolute, child.name);
        const kind = child.isSymbolicLink()
          ? "symlink"
          : child.isDirectory()
            ? "directory"
            : child.isFile()
              ? "file"
              : "other";
        const projectPath = slashPath(relative(root, absolute));
        if (projectPath.toLocaleLowerCase().includes(needle)) {
          entries.push(await describeEntry(root, absolute, child.name));
        }
        if (kind === "directory" && directory.depth < maxDepth && !ignored.has(child.name)) {
          queue.push({ absolute, depth: directory.depth + 1 });
        } else if (kind === "directory" && directory.depth >= maxDepth) {
          truncated = true;
        }
      }
      if (visitedEntries >= maxVisited || entries.length >= maxResults) {
        truncated ||= queueIndex < queue.length - 1;
        break;
      }
    }
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError("operation-failed", "Unable to search this workspace.");
  }
  entries.sort(compareEntries);
  return { entries, visitedEntries, truncated };
}

async function readSecureFile(root: string, relativePath: string, maxBytes: number): Promise<WorkspaceTextFile> {
  const target = await secureExistingPath(root, relativePath, "file");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target.absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile()) throw new WorkspaceError("not-file", "The requested path is not a regular file.");
    if (info.size > maxBytes) {
      throw new WorkspaceError("file-too-large", `This file is larger than the ${Math.ceil(maxBytes / 1024)} KB viewing limit.`);
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      throw new WorkspaceError("file-too-large", `This file is larger than the ${Math.ceil(maxBytes / 1024)} KB viewing limit.`);
    }
    const bytes = buffer.subarray(0, offset);
    if (bytes.includes(0)) throw new WorkspaceError("not-text", "This file does not appear to be UTF-8 text.");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new WorkspaceError("not-text", "This file is not valid UTF-8 text.");
    }
    return {
      path: target.relativePath,
      content,
      size: offset,
      modifiedAt: info.mtime.toISOString(),
    };
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError("operation-failed", "Unable to read this workspace file.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readWorkspaceTextFile(
  workspacePath: string,
  relativePath: string,
  options: ReadTextOptions = {},
): Promise<WorkspaceTextFile> {
  const root = await workspaceRoot(workspacePath);
  const maxBytes = boundedInteger(options.maxBytes, DEFAULT_TEXT_BYTES, MAX_TEXT_BYTES);
  return readSecureFile(root, relativePath, maxBytes);
}

async function detectPackageManager(root: string): Promise<PackageManager> {
  const candidates: Array<[string, PackageManager]> = [
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
  ];
  for (const [file, manager] of candidates) {
    try {
      const info = await lstat(resolve(root, file));
      if (info.isFile() && !info.isSymbolicLink()) return manager;
    } catch {
      // A missing lockfile simply means this package manager is not detected.
    }
  }
  return "unknown";
}

function scriptRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const scripts: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, command] of Object.entries(value).slice(0, 200)) {
    if (
      typeof command === "string" &&
      name.length > 0 &&
      name.length <= 200 &&
      command.length > 0 &&
      command.length <= 20_000 &&
      !/[\0\r\n]/u.test(name)
    ) {
      scripts[name] = command;
    }
  }
  return scripts;
}

export async function discoverPackageScripts(workspacePath: string): Promise<PackageScripts> {
  const root = await workspaceRoot(workspacePath);
  let file: WorkspaceTextFile;
  try {
    file = await readSecureFile(root, "package.json", PACKAGE_JSON_BYTES);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "not-found") {
      throw new WorkspaceError("not-found", "No package.json was found at the workspace root.");
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(file.content) as unknown;
  } catch {
    throw new WorkspaceError("invalid-package", "The workspace package.json is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkspaceError("invalid-package", "The workspace package.json must contain a JSON object.");
  }
  const scripts = scriptRecord((value as { scripts?: unknown }).scripts);
  return {
    packageJsonPath: file.path,
    packageManager: await detectPackageManager(root),
    scripts: Object.entries(scripts).map(([name, command]) => ({ name, command })),
    scriptMap: Object.freeze({ ...scripts }),
  };
}

function previewScore(script: PackageScript): { score: number; reason: string } | null {
  const name = script.name.toLocaleLowerCase();
  const command = script.command.toLocaleLowerCase();
  if (/^(pre|post)(dev|start|serve|preview)$/u.test(name)) return null;
  if (/(^|:)(test|lint|typecheck|check|build|format|deploy|release|e2e)(:|$)/u.test(name)) return null;

  const commandLooksLikePreview =
    /(^|\s)(vite|next dev|next start|astro dev|astro preview|nuxt dev|nuxt preview|react-scripts start|webpack serve|parcel|remix dev|gatsby develop|ng serve|http-server|live-server|serve)(\s|$)/u.test(
      command,
    );
  if (name === "dev") return { score: commandLooksLikePreview ? 100 : 85, reason: "The conventional local development script." };
  if (name === "preview") return { score: commandLooksLikePreview ? 95 : 80, reason: "The conventional local preview script." };
  if (name === "start") return { score: commandLooksLikePreview ? 90 : 65, reason: "A conventional application start script." };
  if (name === "serve") return { score: commandLooksLikePreview ? 88 : 60, reason: "A conventional local serving script." };
  if (/^(dev|preview|serve|start)(:|-)/u.test(name)) {
    return { score: commandLooksLikePreview ? 82 : 55, reason: "A named development or preview variant." };
  }
  if (commandLooksLikePreview) return { score: 70, reason: "The command invokes a recognized local web server." };
  return null;
}

export function identifyPreviewScripts(
  scripts: Readonly<Record<string, string>> | readonly PackageScript[],
): PreviewScript[] {
  const entries: PackageScript[] = [];
  if (Array.isArray(scripts)) {
    entries.push(...scripts.slice(0, 200));
  } else {
    const scriptRecord = scripts as Readonly<Record<string, string>>;
    for (const name in scriptRecord) {
      if (entries.length >= 200) break;
      if (Object.hasOwn(scriptRecord, name)) entries.push({ name, command: scriptRecord[name] });
    }
  }
  return entries
    .filter(
      (script) =>
        typeof script.name === "string" &&
        typeof script.command === "string" &&
        script.name.length > 0 &&
        script.name.length <= 200 &&
        script.command.length > 0 &&
        script.command.length <= 20_000 &&
        !/[\0\r\n]/u.test(script.name),
    )
    .map((script) => ({ script, match: previewScore(script) }))
    .filter((item): item is { script: PackageScript; match: { score: number; reason: string } } => item.match !== null)
    .sort((left, right) => right.match.score - left.match.score || left.script.name.localeCompare(right.script.name))
    .slice(0, 12)
    .map(({ script, match }) => ({
      ...script,
      confidence: match.score >= 85 ? "high" : match.score >= 65 ? "medium" : "low",
      reason: match.reason,
    }));
}

export async function discoverPreviewScripts(workspacePath: string): Promise<PreviewScript[]> {
  const discovered = await discoverPackageScripts(workspacePath);
  return identifyPreviewScripts(discovered.scripts);
}
