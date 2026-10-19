import { realpath } from "node:fs/promises";
import { posix, resolve, win32 } from "node:path";

import {
  MAX_TERMINAL_PATH_LOCATION,
  MAX_TERMINAL_PATH_TEXT_LENGTH,
  type TerminalPathResolution,
} from "../shared/contracts/terminal-links";
import { resolveWorkspacePathForOpen } from "./workspace";

export interface TerminalPathReference {
  path: string;
  line: number | null;
  column: number | null;
}

const LOCATION_SUFFIX = /^(.+?)(?::(\d{1,9})(?::(\d{1,9}))?|\((\d{1,9})(?:,\s?(\d{1,9}))?\))$/u;

function locationNumber(value: string | undefined): number | null | undefined {
  if (value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= MAX_TERMINAL_PATH_LOCATION
    ? number
    : undefined;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Splits a terminal token into a path and an optional `:line[:column]` or
 * compiler-style `(line,column)` location. URLs, home-relative paths and
 * control characters are refused rather than guessed at.
 */
export function parseTerminalPathReference(text: string): TerminalPathReference | null {
  if (
    typeof text !== "string"
    || text.length === 0
    || text.length > MAX_TERMINAL_PATH_TEXT_LENGTH
    || hasControlCharacter(text)
  ) return null;
  const match = LOCATION_SUFFIX.exec(text);
  const path = match?.[1] ?? text;
  const line = locationNumber(match?.[2] ?? match?.[4]);
  const column = locationNumber(match?.[3] ?? match?.[5]);
  if (line === undefined || column === undefined) return null;
  if (
    path.includes("://")
    || path.startsWith("~")
    || /\s$/u.test(path)
    || /^\s/u.test(path)
  ) return null;
  return { path, line, column };
}

/**
 * Maps a terminal path onto a workspace-relative candidate using only string
 * rules for the given platform. `bases` are the workspace root spellings
 * (canonical first); relative paths resolve against the canonical root.
 * The result still has to pass the runtime's realpath containment check.
 */
export function workspaceRelativeCandidate(
  path: string,
  bases: readonly string[],
  platform: NodeJS.Platform,
): string | null {
  const paths = platform === "win32" ? win32 : posix;
  const [canonicalBase] = bases;
  if (!canonicalBase) return null;
  let absolute: string;
  if (platform === "win32") {
    // Device namespaces, and root- or drive-relative forms that depend on the
    // runtime's current drive, are refused instead of being resolved.
    if (/^[\\/]{2}[?.][\\/]/u.test(path)) return null;
    const driveAbsolute = /^[A-Za-z]:[\\/]/u.test(path);
    const unc = /^[\\/]{2}[^\\/?.]/u.test(path);
    if (!driveAbsolute && !unc && (/^[\\/]/u.test(path) || /^[A-Za-z]:/u.test(path))) return null;
    absolute = driveAbsolute || unc ? paths.resolve(path) : paths.resolve(canonicalBase, path);
  } else {
    absolute = paths.isAbsolute(path) ? paths.resolve(path) : paths.resolve(canonicalBase, path);
  }
  for (const base of bases) {
    const child = paths.relative(paths.resolve(base), absolute);
    if (
      child === ""
      || paths.isAbsolute(child)
      || child.split(paths.sep)[0] === ".."
    ) continue;
    return child.split(paths.sep).join("/");
  }
  return null;
}

function portableProjectPath(path: string): boolean {
  return path.length > 0
    && !path.includes("\\")
    && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Resolves a terminal token to an existing regular file inside the workspace.
 * Containment is enforced on the canonical (realpath) target, so traversal and
 * symbolic links that leave the workspace resolve to null.
 */
export async function resolveTerminalPath(
  workspacePath: string,
  text: string,
  platform: NodeJS.Platform = process.platform,
): Promise<TerminalPathResolution | null> {
  const reference = parseTerminalPathReference(text);
  if (!reference) return null;
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(resolve(workspacePath));
  } catch {
    return null;
  }
  const relativePath = workspaceRelativeCandidate(
    reference.path,
    [canonicalRoot, resolve(workspacePath)],
    platform,
  );
  if (!relativePath) return null;
  try {
    const resolved = await resolveWorkspacePathForOpen(workspacePath, relativePath);
    if (resolved.kind !== "file" || !portableProjectPath(resolved.relativePath)) return null;
    return {
      projectPath: resolved.relativePath,
      line: reference.line,
      column: reference.line === null ? null : reference.column,
    };
  } catch {
    return null;
  }
}
