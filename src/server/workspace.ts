import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  stat,
} from "node:fs/promises";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import { FILE_OPEN_NO_FOLLOW } from
  "../node/platform-file-open-flags";
import { secureFilePathSegments } from "../node/secure-file-protocol";
import { MAX_WORKSPACE_FILE_EDIT_BYTES } from "../shared/contracts/workspace";
import {
  SecureFileError,
  type RuntimeSecureFileBroker,
  type SecureFileRead,
  type SecureFileRootCapability,
} from "./secure-files";
import {
  compareWorkspaceEntries,
  describeStableWorkspaceEntry,
  describeStableWorkspaceEntries,
  openStableWorkspaceDirectory,
  workspaceDirentKind,
  type WorkspaceEntry,
  type WorkspaceEntryIdentity,
  type WorkspaceEntryKind,
} from "./workspace-traversal";

export type {
  WorkspaceEntry,
  WorkspaceEntryKind,
} from "./workspace-traversal";

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
const workspaceWriteTails = new Map<string, Promise<void>>();

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
  | "conflict"
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

export interface WorkspaceEntryList {
  directory: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}

export interface ListWorkspaceOptions {
  includeHidden?: boolean;
  maxEntries?: number;
  /** Focused race hook; production callers never provide it. */
  afterEntryObserved?: (path: string) => void | Promise<void>;
}

export interface SearchWorkspaceOptions {
  includeHidden?: boolean;
  maxResults?: number;
  maxDepth?: number;
  maxVisitedEntries?: number;
  ignoredDirectories?: readonly string[];
  /** Focused race hook; production callers never provide it. */
  afterEntryObserved?: (path: string) => void | Promise<void>;
}

export interface WorkspaceSearchResult {
  entries: WorkspaceEntry[];
  visitedEntries: number;
  truncated: boolean;
}

export interface ReadTextOptions {
  maxBytes?: number;
  secureFiles?: RuntimeSecureFileBroker;
  /** Runtime-owned authority retained from the command that exposed the file. */
  secureRoot?: SecureFileRootCapability;
}

export interface WorkspaceWriteOptions extends ReadTextOptions {
  /** Focused race hook; production callers never provide it. */
  afterDigestVerified?: () => void | Promise<void>;
  /** Focused rollback hook; production callers never provide it. */
  afterWriteSynced?: () => void | Promise<void>;
}

export interface WorkspaceTextFile {
  path: string;
  content: string;
  size: number;
  modifiedAt: string;
  contentDigest: string;
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

function workspacePathSegments(path: string): string[] {
  return path.split(process.platform === "win32" ? /[\\/]/u : "/");
}

function hasInvalidPlatformPathPrefix(path: string): boolean {
  return process.platform === "win32"
    ? /^[\\/]/u.test(path) || /^[A-Za-z]:/u.test(path)
    : path.startsWith("/");
}

function validateOpenRelativePath(path: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > MAX_PATH_LENGTH ||
    /[\0\r\n]/u.test(path) ||
    isAbsolute(path) ||
    hasInvalidPlatformPathPrefix(path) ||
    workspacePathSegments(path).some((segment) => segment === "..")
  ) {
    throw new WorkspaceError("invalid-input", "The project path is invalid.");
  }
  return path;
}

function validateRelativePath(path: string, allowRoot: boolean): string {
  if (
    typeof path !== "string" ||
    path.length > MAX_PATH_LENGTH ||
    /[\0\r\n]/u.test(path) ||
    isAbsolute(path) ||
    hasInvalidPlatformPathPrefix(path) ||
    workspacePathSegments(path).some((segment) => segment === "..")
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

export interface ResolvedWorkspacePath {
  absolute: string;
  relativePath: string;
  kind: "file" | "directory";
}

export async function resolveWorkspacePathForOpen(
  workspacePath: string,
  relativePath: string,
): Promise<ResolvedWorkspacePath> {
  const root = await workspaceRoot(workspacePath);
  const normalized = validateOpenRelativePath(relativePath);
  const candidate = resolve(root, normalized);
  if (!isContained(root, candidate)) {
    throw new WorkspaceError("outside-workspace", "The requested path is outside the project.");
  }
  try {
    const canonical = await realpath(candidate);
    if (!isContained(root, canonical)) {
      throw new WorkspaceError("outside-workspace", "The requested path resolves outside the project.");
    }
    const info = await lstat(canonical);
    const kind = info.isFile() ? "file" : info.isDirectory() ? "directory" : null;
    if (!kind) throw new WorkspaceError("invalid-input", "Only project files and folders can be opened.");
    return {
      absolute: canonical,
      relativePath: slashPath(relative(root, canonical)) || ".",
      kind,
    };
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError("not-found", "The requested project path could not be found.");
  }
}

async function secureExistingPath(
  root: string,
  relativePath: string,
  expected: "file" | "directory",
): Promise<{
  absolute: string;
  relativePath: string;
  identity: WorkspaceEntryIdentity;
}> {
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
    return {
      absolute: canonical,
      relativePath: slashPath(relative(root, canonical)) || ".",
      identity: { dev: info.dev, ino: info.ino },
    };
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError("not-found", "The requested workspace entry could not be found.");
  }
}

async function describeEntry(
  root: string,
  parentAbsolute: string,
  parentIdentity: WorkspaceEntryIdentity,
  absolute: string,
  name: string,
  observedKind: WorkspaceEntryKind,
): Promise<{ entry: WorkspaceEntry; identity: WorkspaceEntryIdentity } | null> {
  const described = await describeStableWorkspaceEntry(
    root,
    parentAbsolute,
    parentIdentity,
    absolute,
    observedKind,
  );
  if (!described) return null;
  return {
    entry: {
      name,
      path: slashPath(relative(root, absolute)),
      kind: described.kind,
      size: described.size,
      modifiedAt: described.modifiedAt,
      hidden: name.startsWith("."),
    },
    identity: described.identity,
  };
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
    const children: Array<{ absolute: string; name: string; kind: WorkspaceEntryKind }> = [];
    let truncated = false;
    const directoryHandle = await openStableWorkspaceDirectory(
      root,
      target.absolute,
      target.identity,
    );
    if (!directoryHandle) throw new WorkspaceError("unsafe-link", "The workspace folder changed while it was listed.");
    for await (const child of directoryHandle) {
      if (!options.includeHidden && child.name.startsWith(".")) continue;
      if (children.length >= maxEntries) {
        truncated = true;
        break;
      }
      children.push({
        absolute: resolve(target.absolute, child.name),
        name: child.name,
        kind: workspaceDirentKind(child),
      });
    }
    // Bound metadata fan-out so large directories remain responsive without
    // opening hundreds of filesystem operations at once.
    for (let offset = 0; offset < children.length; offset += 32) {
      const batch = children.slice(offset, offset + 32);
      await Promise.all(batch.map(async ({ absolute }) => {
        await options.afterEntryObserved?.(slashPath(relative(root, absolute)));
      }));
      const described = await describeStableWorkspaceEntries(
        root,
        target.absolute,
        target.identity,
        batch.map(({ absolute, kind }) => ({ absolute, kind })),
      );
      for (let index = 0; index < batch.length; index += 1) {
        const stable = described[index];
        const child = batch[index];
        if (!stable || !child) continue;
        entries.push({
          name: child.name,
          path: slashPath(relative(root, child.absolute)),
          kind: stable.kind,
          size: stable.size,
          modifiedAt: stable.modifiedAt,
          hidden: child.name.startsWith("."),
        });
      }
    }
    entries.sort(compareWorkspaceEntries);
    return { directory: target.relativePath === "." ? "" : target.relativePath, entries, truncated };
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError("operation-failed", "Unable to list this workspace folder.");
  }
}

type SearchQueueEntry = {
  absolute: string;
  depth: number;
  identity: WorkspaceEntryIdentity;
};

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
  const rootInfo = await lstat(root);
  const queue: SearchQueueEntry[] = [{
    absolute: root,
    depth: 0,
    identity: { dev: rootInfo.dev, ino: rootInfo.ino },
  }];
  const entries: WorkspaceEntry[] = [];
  let visitedEntries = 0;
  let truncated = false;

  try {
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const directory = queue[queueIndex];
      const directoryHandle = await openStableWorkspaceDirectory(
        root,
        directory.absolute,
        directory.identity,
      );
      if (!directoryHandle) continue;
      for await (const child of directoryHandle) {
        if (visitedEntries >= maxVisited || entries.length >= maxResults) {
          truncated = true;
          break;
        }
        visitedEntries += 1;
        const hidden = child.name.startsWith(".");
        if (hidden && !options.includeHidden) continue;
        const absolute = resolve(directory.absolute, child.name);
        const kind = workspaceDirentKind(child);
        const projectPath = slashPath(relative(root, absolute));
        const matches = projectPath.toLocaleLowerCase().includes(needle);
        const traversable = kind === "directory" && !ignored.has(child.name);
        if (!matches && !traversable) continue;
        await options.afterEntryObserved?.(projectPath);
        const described = await describeEntry(
          root,
          directory.absolute,
          directory.identity,
          absolute,
          child.name,
          kind,
        );
        if (!described) continue;
        if (matches) entries.push(described.entry);
        if (described.entry.kind === "directory" && directory.depth < maxDepth && !ignored.has(child.name)) {
          queue.push({ absolute, depth: directory.depth + 1, identity: described.identity });
        } else if (described.entry.kind === "directory" && directory.depth >= maxDepth) {
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
  entries.sort(compareWorkspaceEntries);
  return { entries, visitedEntries, truncated };
}

function readTextFileResult(
  read: SecureFileRead,
  relativePath: string,
  maxBytes: number,
): WorkspaceTextFile {
  if (read.size > maxBytes) {
    throw new WorkspaceError(
      "file-too-large",
      `This file is larger than the ${Math.ceil(maxBytes / 1024)} KB viewing limit.`,
    );
  }
  const bytes = read.content;
  if (bytes.includes(0)) {
    throw new WorkspaceError(
      "not-text",
      "This file does not appear to be UTF-8 text.",
    );
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", {
      fatal: true,
      // Keep a leading BOM in the editable text so a read/edit/write round trip
      // cannot silently change the file's encoding marker.
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    throw new WorkspaceError("not-text", "This file is not valid UTF-8 text.");
  }
  return {
    path: relativePath,
    content,
    size: read.size,
    modifiedAt: read.modifiedAt,
    contentDigest: read.digest,
  };
}

function sameIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readTextFileHandle(
  handle: Awaited<ReturnType<typeof open>>,
  relativePath: string,
  maxBytes: number,
): Promise<WorkspaceTextFile> {
  const info = await handle.stat();
  if (!info.isFile()) {
    throw new WorkspaceError(
      "not-file",
      "The requested path is not a regular file.",
    );
  }
  if (info.size > maxBytes) {
    throw new WorkspaceError(
      "file-too-large",
      `This file is larger than the ${Math.ceil(maxBytes / 1024)} KB viewing limit.`,
    );
  }
  const buffer = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maxBytes) {
    throw new WorkspaceError(
      "file-too-large",
      `This file is larger than the ${Math.ceil(maxBytes / 1024)} KB viewing limit.`,
    );
  }
  return readTextFileResult(
    {
      content: buffer.subarray(0, offset),
      size: offset,
      modifiedAt: info.mtime.toISOString(),
      digest: createHash("sha256")
        .update(buffer.subarray(0, offset))
        .digest("hex"),
      mode: info.mode & 0o777,
    },
    relativePath,
    maxBytes,
  );
}

async function readSecureFile(
  root: string,
  relativePath: string,
  maxBytes: number,
): Promise<WorkspaceTextFile> {
  const target = await secureExistingPath(root, relativePath, "file");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      target.absolute,
      fsConstants.O_RDONLY | FILE_OPEN_NO_FOLLOW,
    );
    const info = await handle.stat();
    if (!sameIdentity(target.identity, info)) {
      throw new WorkspaceError(
        "unsafe-link",
        "The workspace file changed while it was being opened.",
      );
    }
    return await readTextFileHandle(
      handle,
      target.relativePath,
      maxBytes,
    );
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError(
      "operation-failed",
      "Unable to read this workspace file.",
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function secureRelativeFilePath(
  relativePath: string,
): string {
  validateRelativePath(relativePath, false);
  const segments = secureFilePathSegments(relativePath);
  if (!segments) {
    throw new WorkspaceError(
      "invalid-input",
      "The workspace file path is invalid.",
    );
  }
  return segments.join("/");
}

function workspaceSecureFileError(error: unknown, action: "read" | "save"): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  if (error instanceof SecureFileError) {
    const code: WorkspaceErrorCode = error.code === "conflict"
      ? "conflict"
      : error.code === "not-found"
        ? "not-found"
        : error.code === "too-large"
          ? "file-too-large"
          : error.code === "invalid"
            ? "invalid-input"
            : error.code === "unsafe"
              ? "unsafe-link"
              : "operation-failed";
    return new WorkspaceError(code, error.message);
  }
  return new WorkspaceError(
    "operation-failed",
    action === "read"
      ? "Unable to read this workspace file."
      : "Unable to save this workspace file.",
  );
}

async function withWorkspaceWriteLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = workspaceWriteTails.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = predecessor.catch(() => undefined).then(() => gate);
  workspaceWriteTails.set(key, tail);
  await predecessor.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (workspaceWriteTails.get(key) === tail) {
      workspaceWriteTails.delete(key);
    }
  }
}

export async function readWorkspaceTextFile(
  workspacePath: string,
  relativePath: string,
  options: ReadTextOptions = {},
): Promise<WorkspaceTextFile> {
  const maxBytes = boundedInteger(options.maxBytes, DEFAULT_TEXT_BYTES, MAX_TEXT_BYTES);
  const path = secureRelativeFilePath(relativePath);
  if (!options.secureFiles) {
    throw new WorkspaceError(
      "operation-failed",
      "Secure workspace file access is unavailable.",
    );
  }
  try {
    const rootCapability = options.secureRoot
      ?? await options.secureFiles.authorizeRoot(
        await workspaceRoot(workspacePath),
      );
    await options.secureFiles.verifyRoot(rootCapability);
    return readTextFileResult(
      await options.secureFiles.read(rootCapability, path, maxBytes),
      path,
      maxBytes,
    );
  } catch (error) {
    throw workspaceSecureFileError(error, "read");
  }
}

export async function writeWorkspaceTextFile(
  workspacePath: string,
  relativePath: string,
  content: string,
  expectedDigest: string,
  options: WorkspaceWriteOptions = {},
): Promise<WorkspaceTextFile> {
  const maxBytes = Math.min(
    boundedInteger(
      options.maxBytes,
      MAX_WORKSPACE_FILE_EDIT_BYTES,
      MAX_TEXT_BYTES,
    ),
    MAX_WORKSPACE_FILE_EDIT_BYTES,
  );
  if (!/^[a-f0-9]{64}$/u.test(expectedDigest)) {
    throw new WorkspaceError(
      "invalid-input",
      "The expected file version is invalid.",
    );
  }
  if (content.includes("\0")) {
    throw new WorkspaceError(
      "not-text",
      "Files containing null bytes cannot be edited here.",
    );
  }
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength > maxBytes) {
    throw new WorkspaceError(
      "file-too-large",
      `This file is larger than the ${Math.ceil(maxBytes / 1024)} KB editing limit.`,
    );
  }

  const path = secureRelativeFilePath(relativePath);
  if (!options.secureFiles) {
    throw new WorkspaceError(
      "operation-failed",
      "Secure workspace file access is unavailable.",
    );
  }
  let rootCapability: Awaited<
    ReturnType<RuntimeSecureFileBroker["authorizeRoot"]>
  >;
  try {
    rootCapability = options.secureRoot
      ?? await options.secureFiles.authorizeRoot(
        await workspaceRoot(workspacePath),
      );
    await options.secureFiles.verifyRoot(rootCapability);
  } catch (error) {
    throw workspaceSecureFileError(error, "save");
  }
  const writeKey = [
    rootCapability.identity.dev,
    rootCapability.identity.ino,
    path,
  ].join("\0");
  return withWorkspaceWriteLock(writeKey, async () => {
    try {
      const initialRead = await options.secureFiles!.read(
        rootCapability,
        path,
        maxBytes,
      );
      const initial = readTextFileResult(initialRead, path, maxBytes);
      if (initial.contentDigest !== expectedDigest) {
        throw new WorkspaceError(
          "conflict",
          "This file changed after it was opened. Reload it before saving.",
        );
      }
      await options.afterDigestVerified?.();
      const originalBytes = Buffer.from(initial.content, "utf8");
      const desiredDigest = createHash("sha256").update(bytes).digest("hex");
      let saved: Awaited<ReturnType<RuntimeSecureFileBroker["replace"]>>;
      try {
        saved = await options.secureFiles!.replace(
          rootCapability,
          path,
          bytes,
          expectedDigest,
          initialRead.mode,
          initialRead.mode,
          maxBytes,
        );
      } catch (error) {
        const current = await options.secureFiles!.read(
          rootCapability,
          path,
          maxBytes,
        ).catch(() => null);
        if (current?.digest === desiredDigest) {
          return {
            path,
            content,
            size: current.size,
            modifiedAt: current.modifiedAt,
            contentDigest: current.digest,
          };
        }
        if (current?.digest === expectedDigest) {
          throw error;
        }
        throw new WorkspaceError(
          "conflict",
          "The save outcome could not be verified. Reload the file before editing it again.",
        );
      }
      try {
        await options.afterWriteSynced?.();
        if (saved.digest !== desiredDigest) {
          throw new WorkspaceError(
            "conflict",
            "This file changed while it was being saved. Reload it and try again.",
          );
        }
        return {
          path,
          content,
          size: saved.size,
          modifiedAt: saved.modifiedAt,
          contentDigest: saved.digest,
        };
      } catch (error) {
        const current = await options.secureFiles!.read(
          rootCapability,
          path,
          maxBytes,
        ).catch(() => null);
        if (current?.digest === desiredDigest) {
          await options.secureFiles!.replace(
            rootCapability,
            path,
            originalBytes,
            current.digest,
            current.mode,
            initialRead.mode,
            maxBytes,
          ).catch(() => undefined);
        }
        throw error;
      }
    } catch (error) {
      throw workspaceSecureFileError(error, "save");
    }
  });
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
