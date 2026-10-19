import { homedir } from "node:os";

import { stripTerminalControlSequences } from "../provider/activity-detail";
import { scrubCommandSecrets } from "../provider/command-secrets";
import { scrubSubagentSecrets } from "../provider/subagent-trace";
import { neutralizeUntrustedAgentText, truncateUtf8 } from "./untrusted-agent-text";

/**
 * Text that `inertia.workspace` tools return comes from the workspace, from
 * provider plans, or from the user's own records. Before it reaches a model:
 *
 * 1. terminal escape sequences and C0/C1 controls are removed;
 * 2. credential-shaped values are replaced with `[redacted]` (the shared
 *    subagent scrubber, plus the command scrubber for Run action commands);
 * 3. the chat's workspace root becomes `<workspace>`, the home directory
 *    `<home>`, and other user, temporary and (for commands) any absolute
 *    paths `<path>`;
 * 4. instruction-shaped text is neutralized as for cross-chat reads; and
 * 5. the result is cut to a UTF-8 byte limit. Neutralizing first keeps every
 *    prefix neutral, so truncating afterwards stays safe.
 */

export interface WorkspaceTextScope {
  /** Absolute workspace and repository roots, shown as `<workspace>`. */
  roots: readonly string[];
  homeDirectory?: string;
  /** Path rules to apply; defaults to the running platform. */
  platform?: NodeJS.Platform;
}

const USER_PATH_POSIX = /(?<![\w.:/~<>-])\/(?:Users|home|root|private\/tmp|private\/var|tmp|var\/folders)(?:\/[^\s"'`,;:()<>[\]{}]+)+/gu;
const USER_PATH_WINDOWS = /(?<![\w.])[A-Za-z]:\\(?:Users|Temp|Windows\\Temp)(?:\\[^\\\s"'`,;()<>[\]{}]+)+/giu;
const ANY_PATH_POSIX = /(?<![\w.:/~<>-])\/(?:[^\s"'\\/]+\/)+([^\s"'\\/]+)/gu;
const ANY_PATH_WINDOWS = /(?<![\w.])[A-Za-z]:\\(?:[^\\\s"']+\\)+([^\\\s"']+)/gu;
const LINE_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/gu;
/** Characters that end a path in prose, commands, and diffs. */
const PATH_DELIMITERS = String.raw`\s"'\x60,;()<>\[\]{}`;

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Matches `root` in any spelling the platform can produce. On Windows that is
 * either separator, runs of them (JSON-escaped text doubles backslashes), any
 * letter case including the drive letter, and a trailing separator. A root
 * must end at a separator or a delimiter, so `C:\a\workspace` never matches
 * inside `C:\a\workspace2`, and must not continue another path.
 */
function rootPattern(root: string, platform: NodeJS.Platform): RegExp | null {
  const windows = platform === "win32";
  const separator = windows ? String.raw`[\\/]` : "/";
  const parts = root.split(windows ? /[\\/]+/u : /\/+/u).filter(Boolean);
  // A root of one segment ("/", "C:") would rewrite every absolute path.
  if (parts.length < (windows && /^[A-Za-z]:$/u.test(parts[0] ?? "") ? 2 : 1)) return null;
  const leadingSeparators = /^[\\/]*/u.exec(root)![0].length;
  const leading = leadingSeparators === 0
    ? ""
    : windows && leadingSeparators >= 2 ? `${separator}{2}` : separator;
  // Text before the root must not be part of a longer path or name.
  const before = String.raw`(?<![\w.~\\/-])`;
  const body = parts.map(escaped).join(`${separator}+`);
  // The rest of the path, up to a delimiter or a ":line" suffix.
  const rest = String.raw`[^${PATH_DELIMITERS}:]*`;
  return new RegExp(
    `${before}${leading}${body}(?:(${separator}+)(${rest}))?(?=$|[${PATH_DELIMITERS}:])`,
    windows ? "giu" : "gu",
  );
}

function replaceRoot(text: string, root: string, replacement: string, platform: NodeJS.Platform): string {
  const pattern = rootPattern(root, platform);
  if (!pattern) return text;
  const separators = platform === "win32" ? /[\\/]+/gu : /\/+/gu;
  return text.replace(pattern, (_match, run: string | undefined, rest: string | undefined) =>
    run === undefined
      ? replacement
      // The separator run after the root becomes one "/"; on Windows, so do
      // the backslashes in the rest of the path.
      : `${replacement}/${(rest ?? "").replace(separators, "/")}`);
}

function scrubPaths(text: string, scope: WorkspaceTextScope, anyPath: boolean): string {
  let result = text;
  const platform = scope.platform ?? process.platform;
  const roots = [...new Set(scope.roots.filter(Boolean))].sort((left, right) => right.length - left.length);
  for (const root of roots) result = replaceRoot(result, root, "<workspace>", platform);
  result = replaceRoot(result, scope.homeDirectory ?? homedir(), "<home>", platform);
  result = result.replace(USER_PATH_POSIX, "<path>").replace(USER_PATH_WINDOWS, "<path>");
  if (anyPath) {
    result = result.replace(ANY_PATH_POSIX, "<path>/$1").replace(ANY_PATH_WINDOWS, "<path>\\$1");
  }
  return result;
}

export interface BoundedWorkspaceText {
  text: string;
  truncated: boolean;
}

/** Multi-line workspace text: diffs, plan documents, task notes. */
export function workspaceText(
  value: string,
  maximumBytes: number,
  scope: WorkspaceTextScope,
): BoundedWorkspaceText {
  const scrubbed = scrubPaths(scrubSubagentSecrets(stripTerminalControlSequences(value)), scope, false);
  return truncateUtf8(neutralizeUntrustedAgentText(scrubbed), maximumBytes);
}

/** A Run action command line; every absolute path keeps only its last segment. */
export function workspaceCommand(
  value: string,
  maximumBytes: number,
  scope: WorkspaceTextScope,
): BoundedWorkspaceText {
  const scrubbed = scrubPaths(scrubCommandSecrets(stripTerminalControlSequences(value)), scope, true);
  return truncateUtf8(neutralizeUntrustedAgentText(scrubbed.replace(/\s+/gu, " ").trim()), maximumBytes);
}

/**
 * One-line values: file paths, branch names, titles. Controls become `?`, as
 * Git prints them, so a crafted file name cannot start a new line.
 */
export function workspaceLabel(
  value: string,
  maximumBytes: number,
  scope: WorkspaceTextScope,
): string {
  const scrubbed = scrubPaths(scrubSubagentSecrets(value.replace(LINE_CONTROLS, "?")), scope, false);
  return truncateUtf8(neutralizeUntrustedAgentText(scrubbed), maximumBytes).text;
}

/** UTF-8 bytes of a value once encoded in a JSON result. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
