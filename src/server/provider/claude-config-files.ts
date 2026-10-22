import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { FILE_OPEN_NO_FOLLOW } from
  "../../node/platform-file-open-flags";
import {
  checkClaudeSkillOperation,
  runClaudeSkillFilesystemOperation,
  type ClaudeSkillOperationControl,
} from "./claude-skill-operation";

const MAX_PROJECT_ANCESTORS = 64;

export interface ClaudeConfigDirectoryEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "link";
}

export interface ClaudeLinkPolicy {
  home: string | null;
  configHomes: readonly string[];
  repository?: string;
}

export function claudeEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const expected = process.platform === "win32" ? name.toLowerCase() : name;
  return Object.entries(environment).find(([key]) =>
    (process.platform === "win32" ? key.toLowerCase() : key) === expected
  )?.[1];
}

export function isContainedPath(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === ""
    || (
      fromRoot !== ".."
      && !fromRoot.startsWith(`..${sep}`)
      && !isAbsolute(fromRoot)
    );
}

export function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (trailing < 0xdc00 || trailing > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export async function plainPathComponents(
  root: string,
  candidate: string,
  control: ClaudeSkillOperationControl,
): Promise<boolean> {
  const fromRoot = relative(root, candidate);
  if (!isContainedPath(root, candidate)) return false;
  let current = root;
  for (const component of fromRoot.split(sep).filter(Boolean)) {
    checkClaudeSkillOperation(control);
    current = join(current, component);
    try {
      const status = await runClaudeSkillFilesystemOperation(
        control,
        "lstat",
        current,
        async () => await lstat(current),
      );
      if (status.isSymbolicLink()) return false;
    } catch {
      checkClaudeSkillOperation(control);
      return false;
    }
  }
  return true;
}

export async function canonicalDirectory(
  path: string,
  control: ClaudeSkillOperationControl,
): Promise<string | null> {
  try {
    const status = await runClaudeSkillFilesystemOperation(
      control,
      "lstat",
      path,
      async () => await lstat(path),
    );
    if (!status.isDirectory() || status.isSymbolicLink()) return null;
    return await runClaudeSkillFilesystemOperation(
      control,
      "realpath",
      path,
      async () => await realpath(path),
    );
  } catch {
    checkClaudeSkillOperation(control);
    return null;
  }
}

export async function claudeProjectDirectories(
  cwd: string,
  control: ClaudeSkillOperationControl,
): Promise<string[]> {
  let canonicalCwd: string;
  try {
    canonicalCwd = await runClaudeSkillFilesystemOperation(
      control,
      "realpath",
      cwd,
      async () => await realpath(cwd),
    );
  } catch {
    checkClaudeSkillOperation(control);
    return [];
  }
  const ancestors: string[] = [];
  let current = canonicalCwd;
  let repositoryRoot: string | null = null;
  for (let depth = 0; depth < MAX_PROJECT_ANCESTORS; depth += 1) {
    checkClaudeSkillOperation(control);
    ancestors.push(current);
    try {
      const markerPath = join(current, ".git");
      const marker = await runClaudeSkillFilesystemOperation(
        control,
        "lstat",
        markerPath,
        async () => await lstat(markerPath),
      );
      if (!marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile())) {
        repositoryRoot = current;
        break;
      }
    } catch {
      checkClaudeSkillOperation(control);
      // Keep walking to the nearest repository marker.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return repositoryRoot
    ? ancestors.slice(0, ancestors.indexOf(repositoryRoot) + 1)
    : ancestors.slice(0, 1);
}

export function claudeHomeDirectory(
  environment: NodeJS.ProcessEnv,
): string | null {
  const home = claudeEnvironmentValue(environment, "HOME")?.trim()
    || claudeEnvironmentValue(environment, "USERPROFILE")?.trim();
  return home && isAbsolute(home) ? resolve(home) : null;
}

export async function claudeUserConfigHome(
  environment: NodeJS.ProcessEnv,
  control: ClaudeSkillOperationControl,
): Promise<string | null> {
  const configured = claudeEnvironmentValue(environment, "CLAUDE_CONFIG_DIR")?.trim();
  const home = claudeHomeDirectory(environment);
  const requestedContainer = configured && isAbsolute(configured)
    ? configured
    : home
      ? join(home, ".claude")
      : null;
  if (!requestedContainer) return null;
  return await canonicalDirectory(requestedContainer, control);
}

export async function readBoundedRegularFile(
  path: string,
  containmentRoot: string,
  maximumBytes: number,
  control: ClaudeSkillOperationControl,
): Promise<Buffer | null> {
  let before: Awaited<ReturnType<typeof lstat>>;
  let resolvedBefore: string;
  try {
    before = await runClaudeSkillFilesystemOperation(
      control,
      "lstat",
      path,
      async () => await lstat(path),
    );
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || before.size > maximumBytes
      || !await plainPathComponents(containmentRoot, path, control)
    ) return null;
    resolvedBefore = await runClaudeSkillFilesystemOperation(
      control,
      "realpath",
      path,
      async () => await realpath(path),
    );
    if (!isContainedPath(containmentRoot, resolvedBefore)) return null;
  } catch {
    checkClaudeSkillOperation(control);
    return null;
  }

  const noFollow = process.platform === "win32" ? 0 : FILE_OPEN_NO_FOLLOW;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await runClaudeSkillFilesystemOperation(
      control,
      "open",
      path,
      async () => await open(path, constants.O_RDONLY | noFollow),
      async (opened) => await opened.close().catch(() => undefined),
    );
    const opened = await runClaudeSkillFilesystemOperation(
      control,
      "fstat",
      path,
      async () => await handle!.stat(),
    );
    const resolvedAfterOpen = await runClaudeSkillFilesystemOperation(
      control,
      "realpath",
      path,
      async () => await realpath(path),
    );
    if (
      !opened.isFile()
      || opened.size > maximumBytes
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || resolvedAfterOpen !== resolvedBefore
    ) return null;
    const output = Buffer.alloc(Math.min(maximumBytes + 1, opened.size + 1));
    let offset = 0;
    while (offset < output.length) {
      checkClaudeSkillOperation(control);
      const { bytesRead } = await runClaudeSkillFilesystemOperation(
        control,
        "read",
        path,
        async () => await handle!.read(
          output,
          offset,
          output.length - offset,
          offset,
        ),
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) return null;
    return output.subarray(0, offset);
  } catch {
    checkClaudeSkillOperation(control);
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readBoundedDirectory(
  directory: string,
  containmentRoot: string,
  maximumEntries: number,
  control: ClaudeSkillOperationControl,
): Promise<ClaudeConfigDirectoryEntry[]> {
  let resolved: string;
  try {
    const status = await runClaudeSkillFilesystemOperation(
      control,
      "lstat",
      directory,
      async () => await lstat(directory),
    );
    if (
      !status.isDirectory()
      || status.isSymbolicLink()
      || !await plainPathComponents(containmentRoot, directory, control)
    ) return [];
    resolved = await runClaudeSkillFilesystemOperation(
      control,
      "realpath",
      directory,
      async () => await realpath(directory),
    );
    if (!isContainedPath(containmentRoot, resolved)) return [];
  } catch {
    checkClaudeSkillOperation(control);
    return [];
  }
  const entries: ClaudeConfigDirectoryEntry[] = [];
  let opened: Awaited<ReturnType<typeof opendir>>;
  try {
    opened = await runClaudeSkillFilesystemOperation(
      control,
      "opendir",
      resolved,
      async () => await opendir(resolved),
      async (handle) => await handle.close().catch(() => undefined),
    );
  } catch {
    checkClaudeSkillOperation(control);
    return [];
  }
  try {
    for (let count = 0; count < maximumEntries; count += 1) {
      checkClaudeSkillOperation(control);
      const entry = await runClaudeSkillFilesystemOperation(
        control,
        "readdir",
        resolved,
        async () => await opened.read(),
      );
      if (!entry) break;
      if (entry.isSymbolicLink() || entry.isFile() || entry.isDirectory()) {
        entries.push({
          name: entry.name,
          path: join(resolved, entry.name),
          kind: entry.isSymbolicLink()
            ? "link"
            : entry.isFile() ? "file" : "directory",
        });
      }
    }
  } catch {
    checkClaudeSkillOperation(control);
  } finally {
    await opened.close().catch(() => undefined);
  }
  return entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

export async function claudeLinkPolicy(
  environment: NodeJS.ProcessEnv,
  control: ClaudeSkillOperationControl,
): Promise<ClaudeLinkPolicy> {
  const requestedHome = claudeHomeDirectory(environment);
  const home = requestedHome
    ? await canonicalDirectory(requestedHome, control) ?? requestedHome
    : null;
  const configHome = await claudeUserConfigHome(environment, control);
  return {
    home,
    configHomes: [...new Set([
      ...(configHome ? [configHome] : []),
      ...(home ? [join(home, ".claude")] : []),
    ])],
  };
}

export function isClaudePersonalDirectory(
  directory: string,
  policy: ClaudeLinkPolicy,
): boolean {
  return (policy.home !== null && isContainedPath(directory, policy.home))
    || policy.configHomes.some((configHome) => isContainedPath(configHome, directory));
}

export function claudeLinkTargetAllowed(
  target: string,
  policy: ClaudeLinkPolicy,
  subtree: "skills" | "agents",
): boolean {
  return dirname(target) !== target
    && (policy.repository === undefined || isContainedPath(policy.repository, target))
    && (policy.home === null || !isContainedPath(target, policy.home))
    && policy.configHomes.every((configHome) => {
      const allowed = join(configHome, subtree);
      return !isContainedPath(configHome, target)
        || (target !== allowed && isContainedPath(allowed, target));
    });
}

export async function resolveClaudeLinkTarget(
  link: string,
  kind: "file" | "directory",
  control: ClaudeSkillOperationControl,
): Promise<string | null> {
  try {
    const target = await runClaudeSkillFilesystemOperation(
      control,
      "realpath",
      link,
      async () => await realpath(link),
    );
    const status = await runClaudeSkillFilesystemOperation(
      control,
      "lstat",
      target,
      async () => await lstat(target),
    );
    if (status.isSymbolicLink()) return null;
    return (kind === "file" ? status.isFile() : status.isDirectory()) ? target : null;
  } catch {
    checkClaudeSkillOperation(control);
    return null;
  }
}
